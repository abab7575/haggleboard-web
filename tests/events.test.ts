import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyAgent } from "../lib/agents";
import { closedEventId, eventsWithLazyClose, offerEvents, offersFromEvents } from "../lib/auction";
import { readFixture } from "../lib/catalog";
import { openPglite, openSqlite, purgePlan, type Store } from "../lib/db";
import { eventContext, internalKeyMatches, requestEvents, serviceContext, writeEvents, type EventContext } from "../lib/events";
import { referrerClass } from "../lib/page-read";
import { getOffers, getResult, postRequest, recordOffers, reportOutcome, sellerClass, type Deps } from "../lib/service";
import { agentScorecard, closeOverdueAuctions, publicStats } from "../lib/stats";
import { publicStream, toPublicEvents } from "../lib/stream";
import { exportEvents } from "../scripts/export-events";

process.env.DELETE_TOKEN_KEY ||= "test-delete-token-key";

const variants = readFixture(path.join(process.cwd(), "fixtures", "mini-catalog.json")).variants;
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const DRIVERS: Array<[string, () => Promise<Store>]> = [
  ["pglite (Postgres)", () => openPglite()],
  ["sqlite", () => openSqlite(":memory:")],
];

function outsideContext(agentClass = "claude-user"): EventContext {
  return {
    agent: { agent_class: agentClass, kind: "assistant", signature_agent: null, signature_verified: false },
    internal: false,
    caller_hash: "c".repeat(64),
    channel: "mcp",
  };
}

function depsFor(store: Store, context?: EventContext): Deps {
  return { store, loadVariants: async () => variants, context };
}

const ghost = { brand: "Brooks", model: "Ghost 16", gender: "women", size: "8" };
const privateGhost = {
  ...ghost,
  text: "PRIVATEWORDS women's Brooks Ghost 16 size 8",
  max_price: 777.77,
  country: "US",
  holding: { seller: "SecretSellerCo", price: 118.5, currency: "USD", delivered: true, delivery_by: inDays(5) },
};

/** A private offer one second after the request was posted (so it never shares a millisecond with it). */
async function privateOffer(store: Store, requestId: string, cents: number, at?: number) {
  const now = at ?? Date.parse((await store.getRequest(requestId))!.created_at) + 1_000;
  await recordOffers(
    store,
    requestId,
    [
      {
        store_domain: "example-road.test",
        source: "private_offer",
        via: "store_rule",
        price_cents: cents,
        currency: "USD",
        available: true,
        product_url: "https://example-road.test/products/ghost-16",
        title: "Brooks Ghost 16",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    ],
    { now },
  );
}

describe.each(DRIVERS)("event log on %s", (_name, open) => {
  it("writes request.posted, request.holding, opening offers and the first lead with the request", async () => {
    const store = await open();
    const posted = await postRequest(privateGhost, depsFor(store, outsideContext()));
    const events = await requestEvents(store, posted.id);
    const types = events.map((event) => event.type);
    expect(types).toContain("request.posted");
    expect(types).toContain("request.holding");
    expect(types.filter((type) => type === "offer.made")).toHaveLength(2);
    expect(types.filter((type) => type === "lead.changed")).toHaveLength(1);
    const post = events.find((event) => event.type === "request.posted")!;
    expect(post.agent_class).toBe("claude-user");
    expect(post.internal).toBe(false);
    expect(post.public).toMatchObject({ brand: "Brooks", model: "Ghost 16", channel: "mcp", stated_cap: true, holding: true, window_seconds: 120 });
    // Private things stay in private JSON, and the free text is never logged at all.
    expect(JSON.stringify(events.map((event) => event.public))).not.toMatch(/PRIVATEWORDS|SecretSellerCo|77777|11850|"US"/);
    expect(JSON.stringify(events)).not.toMatch(/PRIVATEWORDS|SecretSellerCo/);
    const holding = events.find((event) => event.type === "request.holding")!;
    expect(holding.private).toMatchObject({ seller_class: "retailer", price_cents: 11850, currency: "USD" });
    expect(post.private).toMatchObject({ max_price_cents: 77777, country: "US" });
    await store.close();
  });

  it("rolls back the request when its event cannot be written (one transaction)", async () => {
    const store = await open();
    await expect(
      store.saveRequest({ id: "00000000-0000-4000-8000-0000000000aa", need_json: "{}", created_at: new Date().toISOString(), delete_token_hmac: null }, [
        ["INSERT INTO events (id) VALUES (?)", ["broken"]],
      ]),
    ).rejects.toThrow();
    expect(await store.select("SELECT id FROM requests WHERE id = ?", ["00000000-0000-4000-8000-0000000000aa"])).toEqual([]);
    await store.close();
  });

  it("emits lead.changed when first place changes, and ignores offers after the deadline", async () => {
    const store = await open();
    const posted = await postRequest({ ...ghost, auction_seconds: 30 }, depsFor(store, outsideContext()));
    await privateOffer(store, posted.id, 11500);
    let events = await requestEvents(store, posted.id);
    const leads = events.filter((event) => event.type === "lead.changed");
    expect(leads.map((event) => event.store_domain)).toEqual(["example-run.test", "example-road.test"]);
    // 115.00 against 119.95: a private offer shows the coarse "within 5%" band, never "up to 5% under".
    expect(leads[1]!.public).toMatchObject({ source: "private_offer", band: "near_public" });
    expect(JSON.stringify(leads[1]!.public)).not.toMatch(/115|11500/);

    // An even lower offer after the deadline is recorded but changes nothing.
    const late = Date.parse(posted.created_at) + 31_000;
    await recordOffers(store, posted.id, [
      { store_domain: "late.test", source: "public_price", via: "watcher", price_cents: 100, currency: "USD", available: true, product_url: "https://late.test/p", title: "x", expires_at: null },
    ], { now: late });
    events = await requestEvents(store, posted.id);
    expect(events.filter((event) => event.type === "lead.changed")).toHaveLength(2);
    expect(offersFromEvents(events).some((offer) => offer.store_domain === "late.test")).toBe(false);
    await store.close();
  });

  it("closes lazily and exactly once, however many readers race", async () => {
    const store = await open();
    const posted = await postRequest({ ...privateGhost, auction_seconds: 30 }, depsFor(store, outsideContext()));
    await privateOffer(store, posted.id, 11500);
    const before = await eventsWithLazyClose(store, posted.id, { now: Date.now() });
    expect(before.some((event) => event.type === "auction.closed")).toBe(false);
    const after = Date.parse(posted.created_at) + 40_000;
    await Promise.all(Array.from({ length: 8 }, () => eventsWithLazyClose(store, posted.id, { now: after })));
    await eventsWithLazyClose(store, posted.id, { now: after + 60_000 });
    const closes = (await requestEvents(store, posted.id)).filter((event) => event.type === "auction.closed");
    expect(closes).toHaveLength(1);
    expect(closes[0]!.id).toBe(closedEventId(posted.id));
    expect(closes[0]!.public).toMatchObject({
      winner: { store: "example-road.test", source: "private_offer", confirmed: true },
      result: "won",
      band: "near_public",
      bidders: 2,
      lead_changes: 2,
      // Public beat flag is withheld with a near_public band (it would split the band again).
      beat_public: null,
    });
    expect(closes[0]!.private).toMatchObject({
      winner_price_cents: 11500,
      gap_to_public_cents: 495,
      gap_to_holding_cents: 350,
      plain_band: "under_0_5",
      beat_public: true,
    });
    await store.close();
  });

  it("gives the poster standing, then the winner with its checkout link, and records the outcome", async () => {
    const store = await open();
    const deps = depsFor(store, outsideContext());
    const posted = await postRequest({ ...ghost, auction_seconds: 30 }, deps);
    expect(posted.auction).toMatchObject({ status: "open", window_seconds: 30 });
    expect(posted.auction!.standing[0]).toMatchObject({ store_domain: "example-run.test", price: "119.95" });
    await privateOffer(store, posted.id, 11500);
    let clock = Date.parse(posted.created_at) + 10_000;
    const during = await getResult({ request_id: posted.id, delete_token: posted.delete_token, wait_seconds: 0 }, deps, { now: () => clock });
    expect(during.auction!.status).toBe("open");
    expect(during.auction!.standing[0]).toMatchObject({ store_domain: "example-road.test", price: "115.00", source: "private_offer" });
    // Waiting: the fake sleep moves the clock past the deadline.
    const result = await getResult({ request_id: posted.id, delete_token: posted.delete_token, wait_seconds: 25 }, deps, {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(result.auction!.status).toBe("closed");
    expect(result.auction!.winner).toMatchObject({ store_domain: "example-road.test", checkout_url: "https://example-road.test/products/ghost-16" });
    await expect(getResult({ request_id: posted.id, delete_token: "x".repeat(43) }, deps)).rejects.toMatchObject({ status: 403 });
    await reportOutcome({ request_id: posted.id, delete_token: posted.delete_token, outcome: "bought_at_winner", reason: "cheapest, call 555 010 2020" }, deps);
    const outcome = (await requestEvents(store, posted.id)).find((event) => event.type === "outcome.reported")!;
    expect(outcome.public).toMatchObject({ outcome: "bought_at_winner", auction_closed: true, reason_given: true });
    expect(outcome.store_domain).toBe("example-road.test");
    expect(String(outcome.private.reason)).not.toMatch(/555/);
    await expect(reportOutcome({ request_id: posted.id, delete_token: posted.delete_token, outcome: "maybe" }, deps)).rejects.toMatchObject({ status: 400 });
    await store.close();
  });

  it("stats leave out internal traffic and give the count and date with every number", async () => {
    const store = await open();
    const outside = await postRequest({ ...ghost, auction_seconds: 30 }, depsFor(store, outsideContext("chatgpt-user")));
    await privateOffer(store, outside.id, 10500);
    await postRequest({ ...ghost, auction_seconds: 30 }, depsFor(store)); // internal (test) traffic
    await postRequest({ ...ghost, auction_seconds: 30 }, depsFor(store, { ...outsideContext("gptbot"), internal: true }));
    const later = Date.now() + 60_000;
    const stats = await publicStats(store, later);
    expect(stats.requests).toMatchObject({ value: 1, count: 1 });
    expect(stats.agent_classes.by_class).toEqual([{ agent_class: "chatgpt-user", count: 1 }]);
    expect(stats.stores_answering.value).toBe(2);
    expect(stats.auctions_closed.value).toBe(1);
    expect(stats.winner_beat_best_public_price).toMatchObject({ value: 1, beat: 1, closed_with_winner: 1 });
    for (const key of ["requests", "stores_answering", "auctions_closed"] as const) expect(stats[key].as_of).toBe(new Date(later).toISOString());
    // Overdue internal auctions are closed too, but never counted.
    expect((await store.select("SELECT COUNT(*) AS n FROM events WHERE type = 'auction.closed'"))[0]!.n).toBeTruthy();
    expect(await closeOverdueAuctions(store, later)).toBe(0);
    await store.close();
  });

  it("purges the caller hash and outcome reasons after 30 days, and keeps the structured events", async () => {
    const store = await open();
    const old = "2020-01-01T00:00:00.000Z";
    await writeEvents(store, [{ type: "outcome.reported", at: old, request_id: "r-old", public: { outcome: "did_not_buy" }, private: { reason: "too slow" } }], outsideContext());
    await store.purgeExpired();
    const rows = await store.select("SELECT public, private, caller_hash FROM events WHERE request_id = 'r-old'");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.caller_hash).toBeNull();
    expect(String(rows[0]!.private)).toBe("{}");
    expect(String(rows[0]!.public)).toContain("did_not_buy");
    expect(purgePlan().some(([sql]) => /DELETE FROM events/.test(sql))).toBe(false);
    await store.close();
  });
});

describe("public event stream", () => {
  it("carries public fields only: no private amounts, holding, cap or text", async () => {
    const store = await openPglite();
    const posted = await postRequest({ ...privateGhost, auction_seconds: 30 }, depsFor(store, outsideContext()));
    await privateOffer(store, posted.id, 11437);
    const stream = (await publicStream(store, posted.id, Date.parse(posted.created_at) + 40_000))!;
    expect(stream.requestLabel).toBe("Women Brooks Ghost 16 size 8");
    expect(stream.status).toBe("closed");
    // example-road.test joined with its public price, so its later private offer is a lead change, not a second join.
    expect(stream.events.map((event) => event.type)).toEqual([
      "auction.opened",
      "store.joined",
      "lead.changed",
      "store.joined",
      "lead.changed",
      "auction.closed",
    ]);
    const body = JSON.stringify(stream);
    expect(body).not.toMatch(/114\.37|11437|PRIVATEWORDS|SecretSellerCo|118\.5|11850|777|"US"|holding|max_price|caller|internal/);
    expect(stream.events.filter((event) => event.type === "store.joined").every((event) => event.source === "public_price")).toBe(true);
    const closed = stream.events.at(-1)!;
    expect(closed).toMatchObject({ type: "auction.closed", winner: { store: "example-road.test" }, band: "near_public" });
    expect(stream.events.map((event) => event.seq)).toEqual(stream.events.map((_, i) => i + 1));
    await store.close();
  });

  it("keeps lead changes in the order they happened when offers arrive together", () => {
    const opened = "2026-01-01T00:00:00.000Z";
    const window = { opened_at: opened, deadline: "2026-01-01T00:02:00.000Z", window_seconds: 120 };
    const offer = (store: string, cents: number) => ({
      store_domain: store, source: "public_price" as const, via: "snapshot", price_cents: cents, currency: "USD", available: true, product_url: `https://${store}/p`, title: null, expires_at: null,
    });
    const { events } = offerEvents("r", window, [], [offer("a.test", 200), offer("b.test", 150), offer("c.test", 100)], Date.parse(opened));
    const rows = [
      { id: "p", at: opened, type: "request.posted" as const, request_id: "r", store_domain: null, agent_class: "x", internal: false, public: { deadline: window.deadline, window_seconds: 120 }, private: {} },
      ...events.map((event, i) => ({ id: `z${9 - i}`, at: event.at!, type: event.type, request_id: "r", store_domain: event.store_domain ?? null, agent_class: "x", internal: false, public: event.public ?? {}, private: event.private ?? {} })),
    ];
    const leads = toPublicEvents(rows).filter((event) => event.type === "lead.changed");
    expect(leads.map((event) => (event.type === "lead.changed" ? event.store : ""))).toEqual(["a.test", "b.test", "c.test"]);
  });

  it("drops events with unknown fields instead of passing them through", () => {
    const events = toPublicEvents([
      { id: "a", at: "2026-01-01T00:00:00.000Z", type: "request.posted", request_id: "r", store_domain: null, agent_class: "x", internal: false, public: { deadline: "2026-01-01T00:02:00.000Z", window_seconds: 120, secret: "S1" }, private: { cap: 1 } },
      { id: "b", at: "2026-01-01T00:00:01.000Z", type: "lead.changed", request_id: "r", store_domain: "s.test", agent_class: "x", internal: false, public: { band: "under_5_10", source: "store_bid", price_cents: 999 }, private: { price_cents: 999 } },
      { id: "c", at: "2026-01-01T00:00:02.000Z", type: "request.holding", request_id: "r", store_domain: null, agent_class: "x", internal: false, public: {}, private: { price_cents: 5 } },
      { id: "d", at: "2026-01-01T00:00:03.000Z", type: "offer.made", request_id: "r", store_domain: "p.test", agent_class: "x", internal: false, public: { source: "private_offer", public_price: "8.88", currency: "USD" }, private: { price_cents: 888 } },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/S1|999|cap|holding|8\.88|888/);
    expect(events).toHaveLength(3);
    expect(events[2]).toMatchObject({ type: "store.joined", store: "p.test", source: "private_offer", public_price: null, currency: null });
  });
});

describe("agent class and internal flag", () => {
  it("classifies known fetchers, libraries, browsers and unknowns", () => {
    expect(classifyAgent("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ChatGPT-User/1.0; +https://openai.com/bot)").agent_class).toBe("chatgpt-user");
    expect(classifyAgent("Claude-User/1.0").kind).toBe("assistant");
    expect(classifyAgent("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)").kind).toBe("search");
    expect(classifyAgent("Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)").kind).toBe("preview");
    expect(classifyAgent("curl/8.4.0").agent_class).toBe("http-library");
    expect(classifyAgent("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15").agent_class).toBe("browser");
    expect(classifyAgent("SomethingNew/0.1").agent_class).toBe("unknown");
    expect(classifyAgent("").agent_class).toBe("unknown");
    expect(classifyAgent("HaggleBoard-bot/0.1").agent_class).toBe("haggleboard");
    const signed = classifyAgent("Mozilla/5.0 Chrome/130", '"https://chatgpt.com"');
    expect(signed).toMatchObject({ agent_class: "chatgpt-agent", signature_agent: "chatgpt.com", signature_verified: false });
  });

  it("marks tests, our own headers and internal keys as internal, and never keeps a raw IP", () => {
    const env = { HB_INTERNAL_KEYS: "a-long-internal-key-0001, short", MCP_CALL_LOG_SALT: "salt" } as unknown as NodeJS.ProcessEnv;
    const outside = new Request("https://haggleboard.com/api/requests", { headers: { "x-real-ip": "203.0.113.9" } });
    // This env has no VITEST, so the request counts as outside unless it carries a key or our headers.
    expect(eventContext(outside, "api", env).internal).toBe(false);
    const keyed = new Request("https://haggleboard.com/api/requests", { headers: { "x-haggleboard-internal-key": "a-long-internal-key-0001" } });
    expect(eventContext(keyed, "api", env).internal).toBe(true);
    const declared = new Request("https://haggleboard.com/api/requests", { headers: { "x-haggleboard-origin": "internal" } });
    expect(eventContext(declared, "api", env).internal).toBe(true);
    expect(eventContext(new Request("http://localhost:3000/api/requests"), "api", env).internal).toBe(true);
    expect(eventContext(outside, "api", process.env).internal).toBe(true);
    expect(internalKeyMatches("a-long-internal-key-0001", env)).toBe(true);
    expect(internalKeyMatches("short", env)).toBe(false);
    expect(internalKeyMatches("nope", env)).toBe(false);
    const ctx = eventContext(outside, "api", env);
    expect(ctx.caller_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(ctx)).not.toContain("203.0.113.9");
    expect(serviceContext().internal).toBe(true);
  });

  it("classifies held-order sellers and referrers coarsely", () => {
    expect(sellerClass("Amazon.com", "Brooks")).toBe("marketplace");
    expect(sellerClass("brooksrunning.com", "Brooks")).toBe("brand_site");
    expect(sellerClass("Local Running Co", "Brooks")).toBe("retailer");
    expect(sellerClass(null, null)).toBe("unknown");
    expect(referrerClass("https://www.google.com/search?q=x", "haggleboard.com")).toBe("search");
    expect(referrerClass("https://chatgpt.com/c/123", "haggleboard.com")).toBe("assistant");
    expect(referrerClass(null, "haggleboard.com")).toBe("none");
  });
});

describe("handles and scorecards", () => {
  it("validates the handle and builds a scorecard from outside traffic only, with no amounts", async () => {
    const store = await openPglite();
    await expect(postRequest({ ...ghost, handle: ["me", "example.org"].join("@") }, depsFor(store))).rejects.toMatchObject({ status: 400 });
    await expect(postRequest({ ...ghost, handle: "15550102020" }, depsFor(store))).rejects.toMatchObject({ status: 400 });
    await expect(postRequest({ ...ghost, handle: "admin" }, depsFor(store))).rejects.toMatchObject({ status: 400 });
    const posted = await postRequest({ ...ghost, handle: "Shoe-Bot", auction_seconds: 30 }, depsFor(store, outsideContext()));
    expect(posted.handle).toBe("shoe-bot");
    await privateOffer(store, posted.id, 10500);
    await postRequest({ ...ghost, handle: "shoe-bot" }, depsFor(store)); // internal, not counted
    const card = (await agentScorecard(store, "shoe-bot", Date.now() + 60_000))!;
    expect(card).toMatchObject({ requests: 1, auctions_closed: 1, beat_best_public_price: 1 });
    expect(JSON.stringify(card)).not.toMatch(/105\.00|119\.95|10500/);
    expect(await agentScorecard(store, "nobody-here")).toBeNull();
    await store.close();
  });
});

describe("routes", () => {
  it("public events, stream, stats and agents routes carry no private field; result needs the token", async () => {
    process.env.DATABASE_URL = "pglite://memory";
    const { getStore } = await import("../lib/db");
    const store = await getStore();
    const deps = depsFor(store, outsideContext());
    const posted = await postRequest({ ...privateGhost, handle: "route-bot", auction_seconds: 30 }, deps);
    await privateOffer(store, posted.id, 11437);
    const params = { params: Promise.resolve({ id: posted.id }) };
    const leak = /114\.37|11437|PRIVATEWORDS|SecretSellerCo|11850|118\.5|77777|777\.77|max_price|"holding"|caller_hash|"private"/;

    const events = await import("../app/api/requests/[id]/events/route");
    const eventsBody = await (await events.GET(new Request(`http://haggleboard.test/api/requests/${posted.id}/events`), params)).text();
    expect(eventsBody).toContain("lead.changed");
    expect(eventsBody).not.toMatch(leak);

    const stream = await import("../app/api/requests/[id]/stream/route");
    const controller = new AbortController();
    const response = await stream.GET(new Request(`http://haggleboard.test/api/requests/${posted.id}/stream`, { signal: controller.signal }), {
      params: Promise.resolve({ id: posted.id }),
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value) + new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    await reader.cancel();
    expect(first).toContain("retry:");
    expect(first).not.toMatch(leak);

    const stats = await import("../app/api/stats/route");
    expect(await (await stats.GET()).text()).not.toMatch(leak);
    const agents = await import("../app/api/agents/[handle]/route");
    const card = await agents.GET(new Request("http://haggleboard.test/api/agents/route-bot"), { params: Promise.resolve({ handle: "route-bot" }) });
    expect(card.status).toBe(200);
    expect(await card.text()).not.toMatch(leak);

    const result = await import("../app/api/requests/[id]/result/route");
    const denied = await result.GET(new Request(`http://haggleboard.test/api/requests/${posted.id}/result?wait=0`), params);
    expect(denied.status).toBe(400);
    const allowed = await result.GET(
      new Request(`http://haggleboard.test/api/requests/${posted.id}/result?wait=0`, { headers: { "x-haggleboard-delete-token": posted.delete_token! } }),
      params,
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain('"standing"');

    const publicRead = await getOffers({ request_id: posted.id }, deps);
    expect(JSON.stringify(publicRead)).not.toMatch(leak);
  });
});

describe("export", () => {
  it("writes the events table to a dated JSONL file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hb-export-"));
    const db = path.join(dir, "export.sqlite");
    const env = { DATABASE_URL: `file:${db}` } as unknown as NodeJS.ProcessEnv;
    const store = await openSqlite(db);
    await postRequest(ghost, depsFor(store, outsideContext()));
    await store.close();
    const result = (await exportEvents(path.join(dir, "out"), env, new Date("2026-11-22T03:00:00Z")))!;
    expect(result.file.endsWith("events-2026-11-22.jsonl")).toBe(true);
    expect(existsSync(result.file)).toBe(true);
    const lines = readFileSync(result.file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string });
    expect(lines.length).toBe(result.rows);
    expect(lines.map((line) => line.type)).toContain("request.posted");
  });
});
