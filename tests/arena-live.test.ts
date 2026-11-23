import fs from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { Arena } from "../components/arena/arena";
import { AgentRecord } from "../components/arena/agent-record";
import { LiveArena } from "../components/arena/live-arena";
import { ResultCard } from "../components/arena/result-card";
import { LiveStrip } from "../components/home/live-strip";
import { PRIVATE_FIELD_NAMES } from "../lib/arena";
import { BAND_POSITION, feedToArena, formatPublicPrice, mergeFeedEvents } from "../lib/arena-live";
import { readFixture } from "../lib/catalog";
import { openPglite, type Store } from "../lib/db";
import type { EventContext } from "../lib/events";
import { homeLive } from "../lib/home-live";
import { postRequest, recordOffers, type Deps } from "../lib/service";
import { agentScorecard } from "../lib/stats";
import { publicStream, type PublicStream } from "../lib/stream";

process.env.DELETE_TOKEN_KEY ||= "test-delete-token-key";

const fixture = readFixture(path.join(process.cwd(), "fixtures", "mini-catalog.json")).variants;
const visibleText = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");

const outside: EventContext = {
  agent: { agent_class: "chatgpt-user", kind: "assistant", signature_agent: null, signature_verified: false },
  internal: false,
  caller_hash: "e".repeat(64),
  channel: "api",
};

/** A feed the way /api/requests/{id}/events returns it. */
const FEED: PublicStream = {
  request_id: "11111111-1111-4111-8111-111111111111",
  requestLabel: "Women Brooks Ghost 16 size 8",
  deadline: "2026-11-22T14:22:00.000Z",
  window_seconds: 120,
  seconds_left: 0,
  status: "closed",
  now: "2026-11-22T14:22:05.000Z",
  test_stores: false,
  events: [
    { seq: 1, type: "auction.opened", at: "2026-11-22T14:20:00.000Z", deadline: "2026-11-22T14:22:00.000Z", window_seconds: 120 },
    {
      seq: 2,
      type: "store.joined",
      at: "2026-11-22T14:20:00.000Z",
      store: "www.example-run.com",
      source: "public_price",
      public_price: "119.95",
      currency: "USD",
      observed_at: "2026-11-22T14:20:00.000Z",
      confirmed: true,
      stale: false,
      test: false,
    },
    { seq: 3, type: "lead.changed", at: "2026-11-22T14:20:00.000Z", store: "www.example-run.com", source: "public_price", band: "at_public", band_label: "at the best public price" },
    {
      seq: 4,
      type: "store.joined",
      at: "2026-11-22T14:20:40.000Z",
      store: "example-road.com",
      source: "private_offer",
      public_price: null,
      currency: null,
      observed_at: null,
      confirmed: true,
      stale: false,
      test: false,
    },
    { seq: 5, type: "lead.changed", at: "2026-11-22T14:20:40.000Z", store: "example-road.com", source: "private_offer", band: "under_5_10", band_label: "5 to 10% under the best public price" },
    {
      seq: 6,
      type: "auction.closed",
      at: "2026-11-22T14:22:00.000Z",
      winner: { store: "example-road.com", source: "private_offer", confirmed: true, observed_at: "2026-11-22T14:20:40.000Z" },
      result: "won",
      result_label: null,
      band: "under_5_10",
      band_label: "5 to 10% under the best public price",
      bidders: 2,
      lead_changes: 2,
    },
  ],
};

describe("feed to arena adapter", () => {
  it("uses the real clock: opens at deadline minus the window, events in seconds since open", () => {
    const arena = feedToArena(FEED);
    expect(arena.opensAt).toBe("2026-11-22T14:20:00.000Z");
    expect(arena.durationSec).toBe(120);
    expect(arena.events.map((e) => [e.kind, e.at])).toEqual([
      ["join", 0],
      ["lead", 0],
      ["join", 40],
      ["lead", 40],
      ["close", 120],
    ]);
  });

  it("shows a public list price only for a public-price offer, and bands for private ones", () => {
    const arena = feedToArena(FEED);
    expect(arena.bidders).toEqual([
      { id: "www.example-run.com", name: "example-run.com", tone: "clay", publicPrice: "$119.95", priceNote: "confirmed today" },
      { id: "example-road.com", name: "example-road.com", tone: "plum" },
    ]);
    const lead = arena.events.find((e) => e.kind === "lead" && e.bidder === "example-road.com");
    expect(lead).toEqual({ kind: "lead", at: 40, bidder: "example-road.com", band: BAND_POSITION.under_5_10, label: "5 to 10% under" });
  });

  it("closes with the true band label, the winner and when the winning offer came in", () => {
    const arena = feedToArena(FEED);
    expect(arena.result).toEqual({
      winner: "example-road.com",
      winnerName: "example-road.com",
      band: "under_5_10",
      label: "5 to 10% under the best public price",
      wonAtSec: 40,
      bidders: 2,
      leadChanges: 2,
      kind: "won",
      kindLabel: null,
      winnerPriceNote: null,
    });
    const close = arena.events.at(-1)!;
    expect(close).toMatchObject({ kind: "close", winner: "example-road.com", saved_pct: null, label: "5 to 10% under the best public price" });
  });

  it("dates every public price, shows withdrawn stores and says plainly when nothing was confirmed", () => {
    const stale: PublicStream = {
      ...FEED,
      events: [
        FEED.events[0]!,
        {
          seq: 2,
          type: "store.joined",
          at: "2026-11-22T14:20:00.000Z",
          store: "old-snapshot.com",
          source: "public_price",
          public_price: "99.00",
          currency: "USD",
          observed_at: "2026-10-18T10:00:00.000Z",
          confirmed: false,
          stale: true,
          test: false,
        },
        {
          seq: 3,
          type: "store.joined",
          at: "2026-11-22T14:20:00.000Z",
          store: "gone-now.com",
          source: "public_price",
          public_price: "89.00",
          currency: "USD",
          observed_at: "2026-10-18T10:00:00.000Z",
          confirmed: false,
          stale: true,
          test: false,
        },
        { seq: 4, type: "store.withdrawn", at: "2026-11-22T14:20:30.000Z", store: "gone-now.com", reason: "not_found", label: "no longer listed" },
        {
          seq: 5,
          type: "auction.closed",
          at: "2026-11-22T14:22:00.000Z",
          winner: { store: "old-snapshot.com", source: "public_price", confirmed: false, observed_at: "2026-10-18T10:00:00.000Z" },
          result: "last_seen",
          result_label: "Best last-seen price, not confirmed today",
          band: "at_public",
          band_label: "at the best public price",
          bidders: 2,
          lead_changes: 0,
        },
      ],
    };
    const arena = feedToArena(stale);
    expect(arena.bidders.find((b) => b.id === "old-snapshot.com")?.priceNote).toBe("last seen 18 Oct, not confirmed");
    expect(arena.bidders.find((b) => b.id === "gone-now.com")?.priceNote).toBe("no longer listed");
    expect(arena.events.find((e) => e.kind === "withdraw")).toMatchObject({ bidder: "gone-now.com", at: 30 });
    expect(arena.result).toMatchObject({ kind: "last_seen", kindLabel: "Best last-seen price, not confirmed today" });
    const html = renderToStaticMarkup(
      h(ResultCard, {
        request: "x",
        winner: "old-snapshot.com",
        bandLabel: arena.result!.label ?? undefined,
        wonAtSec: 0,
        windowSec: 120,
        stores: 2,
        demo: false,
        resultKind: "last_seen",
        priceNote: arena.result!.winnerPriceNote,
      }),
    );
    const text = visibleText(html);
    expect(text).toContain("Best last-seen price, not confirmed today");
    expect(text).toContain("last seen 18 Oct, not confirmed");
    expect(text).not.toMatch(/\bWon\b/);
  });

  it("ignores private fields even if a feed ever carried them", () => {
    const leaky = {
      ...FEED,
      events: FEED.events.map((event) => ({ ...event, amount_cents: 11437, price_cents: 11437, max_price: 777, held_order: "ord_9" })),
    } as unknown as PublicStream;
    const json = JSON.stringify(feedToArena(leaky));
    for (const field of PRIVATE_FIELD_NAMES) expect(json).not.toContain(field);
    expect(json).not.toMatch(/11437|777|ord_9/);
  });

  it("handles no auction, no winner, merges by seq and formats prices", () => {
    expect(feedToArena({ ...FEED, deadline: null, window_seconds: null, status: "no_auction", events: [] }).opensAt).toBeNull();
    const none = feedToArena({
      ...FEED,
      events: [
        FEED.events[0]!,
        { seq: 2, type: "auction.closed", at: FEED.deadline!, winner: null, result: "none", result_label: null, band: null, band_label: null, bidders: 0, lead_changes: 0 },
      ],
    });
    expect(none.joined).toBe(0);
    expect(none.result).toMatchObject({ winner: null, label: null });
    expect(mergeFeedEvents(FEED.events.slice(0, 3), FEED.events.slice(2)).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(formatPublicPrice("119.95", "USD")).toBe("$119.95");
    expect(formatPublicPrice("80", "GBP")).toBe("£80.00");
    expect(formatPublicPrice("80", "UNK")).toBe("80");
    expect(formatPublicPrice(null, "USD")).toBeUndefined();
  });

  it("renders a live arena and a real result card with the band, never a private amount", () => {
    const arena = feedToArena(FEED);
    const html = [
      renderToStaticMarkup(
        h(Arena, {
          request: arena.request,
          durationSec: arena.durationSec,
          bidders: arena.bidders,
          events: arena.events,
          demo: false,
          variant: "full",
          perspective: "public",
          opensAt: arena.opensAt!,
        }),
      ),
      renderToStaticMarkup(
        h(ResultCard, {
          request: arena.request,
          winner: arena.result!.winnerName!,
          bandLabel: arena.result!.label!,
          wonAtSec: arena.result!.wonAtSec,
          windowSec: 120,
          stores: 2,
          demo: false,
          perspective: "public",
        }),
      ),
    ].join("\n");
    const text = visibleText(html);
    expect(html).not.toMatch(/data-demo-label/);
    expect(text).toMatch(/example-road.com wins ?, 5 to 10% under the best public price/);
    expect(text).toContain("$119.95 public price");
    expect(text).toContain("confirmed today");
    expect(text).toContain("Real auction");
    expect(text).toContain("5 to 10%");
    expect(text).not.toContain("Test stores");
    expect(text).toContain("After 40 seconds (clock: 2 minutes)");
    expect(text).not.toMatch(/114\.37|\$114/);
  });
});

describe("live data end to end, from a real request", () => {
  let store: Store;
  let deps: Deps;
  beforeAll(async () => {
    store = await openPglite();
    deps = { store, loadVariants: async () => fixture, context: outside, origin: "outside" };
  });

  it("feeds the arena from the real stream: public price shown, private offer as a band only", async () => {
    const posted = await postRequest({ brand: "Brooks", model: "Ghost 16", gender: "women", size: "8", max_price: 777.77, auction_seconds: 30 }, deps);
    await recordOffers(store, posted.id, [
      { store_domain: "example-private.test", source: "private_offer", via: "store_rule", price_cents: 11437, currency: "USD", available: true, product_url: "https://example-private.test/p", title: "Brooks Ghost 16", expires_at: null },
    ]);
    const stream = (await publicStream(store, posted.id))!;
    const arena = feedToArena(stream);
    expect(arena.status).toBe("open");
    expect(arena.bidders.find((b) => b.id === "example-private.test")?.publicPrice).toBeUndefined();
    expect(arena.bidders.some((b) => b.publicPrice === "$119.95")).toBe(true);
    const html = renderToStaticMarkup(h(LiveArena, { requestId: posted.id, initial: stream, shareUrl: `https://haggleboard.com/r/${posted.id}` }));
    expect(html).toContain("Women Brooks Ghost 16 size 8");
    expect(html).not.toMatch(/114\.37|11437|777/);
    expect(html).not.toContain(posted.delete_token!);

    // After the deadline the first read closes it; the arena shows the true band.
    const later = Date.now() + 40_000;
    const closed = feedToArena((await publicStream(store, posted.id, later))!);
    expect(closed.status).toBe("closed");
    expect(closed.result?.winner).toBe("example-private.test");
    // The store has no public price of its own in this auction, so its private band is withheld.
    expect(closed.result?.label).toBe("private offer");
    expect(closed.result?.kind).toBe("won");
  });

  it("shows an honest empty state when no store answered", async () => {
    const posted = await postRequest({ text: "left-handed cast iron teapot", auction_seconds: 30 }, deps);
    const stream = (await publicStream(store, posted.id, Date.now() + 40_000))!;
    expect(stream.status).toBe("closed");
    const text = visibleText(renderToStaticMarkup(h(LiveArena, { requestId: posted.id, initial: stream, shareUrl: "x" })));
    expect(text).toContain("No store answered in time");
    expect(text).not.toContain("Clock's out. example");
  });

  it("homepage strip: outside requests only, and says so plainly when there are none", async () => {
    const empty = await openPglite();
    const none = await homeLive(empty);
    expect(visibleText(renderToStaticMarkup(h(LiveStrip, { live: none })))).toContain("No real requests yet. Be the first.");
    await postRequest({ brand: "Brooks", model: "Ghost 16", gender: "women", size: "8" }, { store: empty, loadVariants: async () => fixture, origin: "test", context: { ...outside, internal: true } });
    expect((await homeLive(empty)).latest).toHaveLength(0);

    const live = await homeLive(store);
    expect(live.requests).toBeGreaterThan(0);
    expect(live.latest.length).toBeGreaterThan(0);
    const text = visibleText(renderToStaticMarkup(h(LiveStrip, { live })));
    expect(text).toContain("Latest on the board");
    expect(text).not.toContain("No real requests yet");
    expect(text).not.toMatch(/114\.37|777/);
  });

  it("agent scorecard renders from the real record: counts and bands, no amounts", async () => {
    await postRequest({ brand: "Brooks", model: "Ghost 16", gender: "women", size: "8", handle: "trail-bot", auction_seconds: 30 }, deps);
    const card = (await agentScorecard(store, "trail-bot", Date.now() + 40_000))!;
    const html = renderToStaticMarkup(h(AgentRecord, { card }));
    const text = visibleText(html);
    expect(text).toContain("trail-bot");
    expect(text).toContain("Real record");
    expect(text).toMatch(/at the best public price/);
    expect(text).not.toMatch(/\$\d|119\.95/);
    expect(html).not.toMatch(/data-demo-label/);
  });
});

describe("the poster's token never goes into a URL", () => {
  it("homepage keeps it in localStorage and the arena reads a #fragment, then removes it", () => {
    const enhancer = fs.readFileSync(path.join(process.cwd(), "components/home/ask-enhancer.tsx"), "utf8");
    expect(enhancer).toContain("localStorage.setItem(`hb:token:${body.id}`");
    expect(enhancer).toContain("window.location.assign(`/r/${body.id}`)");
    const live = fs.readFileSync(path.join(process.cwd(), "components/arena/live-arena.tsx"), "utf8");
    expect(live).toContain("history.replaceState");
    expect(live).toContain('"x-haggleboard-delete-token": token');
    expect(live).not.toMatch(/[?&](t|token|delete_token)=\$\{/);
    const page = fs.readFileSync(path.join(process.cwd(), "app/r/[id]/page.tsx"), "utf8");
    expect(page).toContain("canonical: `/r/${id}`");
    expect(page).toContain("url: `/r/${id}`");
  });
});
