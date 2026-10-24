import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readFixture } from "../lib/catalog";
import { openPglite as openSqlite, sqlPlaceholders } from "../lib/db";
import { bidsEnabled } from "../lib/keys";
import { clientIp, hashIp, takeRateLimit } from "../lib/rate-limit";
import { readStoreKey } from "../lib/http";
import { getOffers, issueStoreKey, postRequest, publicNeedLabel, reportNeed, searchProducts, submitBid, type Deps } from "../lib/service";
import { handleMcpRequest } from "../mcp/http";
import { claimNext, domainBlocked, emptyQueue, readQueue, writeQueue } from "../feeds/queue";
import { loadSeeds } from "../feeds/seeds";
import type { CatalogVariant } from "../referee/types";

process.env.DELETE_TOKEN_KEY ||= "test-delete-token-key";

const expectedDomains = [
  "pacersrunning.com",
  "gazellesports.com",
  "performancerunning.com",
  "athleticannex.com",
  "sportsbasement.com",
  "skirack.com",
  "therunningwellstore.com",
  "prrunandwalk.com",
  "stridesrunning.com",
  "shopsoledesire.com",
  "motirunning.com",
  "columbusrunning.com",
  "firsttothefinish.com",
  "runnersden.com",
  "coastalrunco.com",
  "commonwealthrunning.com",
  "tortoiseandharesports.com",
  "grivetoutdoors.com",
  "annarborrunningcompany.com",
  "heartbreak.run",
  "superrunnersshop.com",
  "lukeslocker.com",
  "nashvillerunning.com",
  "portlandrunningcompany.com",
  "gearwest.com",
  "verticalrunner.com",
  "millcityrunning.com",
  "scwrun.com",
  "roguevalleyrunners.com",
  "run4it.com",
  "startfitness.co.uk",
  "therunningoutlet.co.uk",
  "achillesheel.co.uk",
  "runningbear.co.uk",
  "upandrunning.co.uk",
  "fitstuff.co.uk",
  "sportlink.co.uk",
  "suttonrunner.com",
  "sporting-feet.com",
  "thesportsroom.ie",
  "therunhub.ie",
  "gleesonsport.ie",
  "amphibianking.ie",
  "runpod.ie",
  "roamrunning.ie",
  "runninglab.com",
  "therunnersshop.com",
  "runningpremium.com",
];

describe("seeds", () => {
  it("lists the public stores and no emails", () => {
    const seeds = loadSeeds();
    expect(seeds.map((seed) => seed.domain)).toEqual(expectedDomains);
    expect(JSON.stringify(seeds)).not.toContain("@");
    expect(seeds.find((seed) => seed.domain === "runninglab.com")?.currency).toBe("SGD");
    expect(seeds.find((seed) => seed.domain === "therunnersshop.com")?.currency).toBe("CAD");
    expect(seeds.find((seed) => seed.domain === "run4it.com")?.currency).toBe("GBP");
    expect(seeds.find((seed) => seed.domain === "runningpremium.com")?.currency).toBeNull();
  });

  it("drops a hostname listed for removal", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hb-seeds-"));
    const file = path.join(dir, "stores.json");
    writeFileSync(
      file,
      JSON.stringify({ stores: [{ domain: "pacersrunning.com", region: "US", country: "US", currency: "USD" }] }),
    );
    expect(loadSeeds(file, new Set(["pacersrunning.com"]))).toEqual([]);
  });
});

describe("queue", () => {
  it("claims a job once and skips a backed-off store", async () => {
    const queue = emptyQueue();
    const now = "2026-10-18T00:00:00.000Z";
    queue.jobs.push({
      id: "a",
      domain: "pacersrunning.com",
      pages: 1,
      limit: 30,
      status: "pending",
      created_at: now,
      updated_at: now,
    });
    const claimed = claimNext(queue, now, "2026-10-17T00:00:00.000Z");
    expect(claimed?.status).toBe("running");
    expect(claimNext(queue, now, "2026-10-17T00:00:00.000Z")).toBeNull();
    queue.jobs[0]!.backoff_until = "2026-10-19T00:00:00.000Z";
    queue.jobs[0]!.status = "pending";
    expect(domainBlocked(queue, "pacersrunning.com", now)).toBe(true);
    expect(claimNext(queue, now, "2026-10-17T00:00:00.000Z")).toBeNull();

    const dir = mkdtempSync(path.join(tmpdir(), "hb-q-"));
    const file = path.join(dir, "queue.json");
    await writeQueue(file, queue);
    expect((await readQueue(file)).jobs).toHaveLength(1);
  });
});

describe("database and offers", () => {
  it("stores requests and ranks fixture offers, including a bid", async () => {
    expect(sqlPlaceholders("SELECT * FROM t WHERE id = ? AND n = ?", "postgres")).toBe(
      "SELECT * FROM t WHERE id = $1 AND n = $2",
    );
    const store = await openSqlite();
    const variants = readFixture(path.join(process.cwd(), "fixtures", "mini-catalog.json")).variants;
    const deps: Deps = { store, loadVariants: async () => variants };
    const posted = await postRequest({ text: "women's Brooks Ghost 16, size 8, under $130" }, deps);
    expect(posted.persisted).toBe(true);
    expect(posted.offers).toHaveLength(1);
    expect(posted.offers[0]?.product_url).toBe("https://example-run.test/products/brooks-ghost-16?variant=1");
    expect(posted.offers[0]?.checkout).toBe("store_site");
    expect(posted.offers[0]?.price_cents).toBe(11995);

    const again = await getOffers({ request_id: posted.id }, deps);
    expect(again.offers[0]?.store_domain).toBe("example-run.test");

    const previousEnabled = process.env.BID_KEYS_ENABLED;
    const previousSigning = process.env.BID_TOKEN_SIGNING_KEY;
    delete process.env.BID_KEYS_ENABLED;
    await expect(
      submitBid(
        {
          store_domain: "example-run.test",
          product_url: "https://example-run.test/products/ghost?variant=9",
          price: 90,
          currency: "usd",
        },
        "x".repeat(43),
        deps,
      ),
    ).rejects.toThrow(/off until/);

    process.env.BID_KEYS_ENABLED = "1";
    process.env.BID_TOKEN_SIGNING_KEY = "test-signing-key";
    expect(readStoreKey(new Headers({ authorization: "Bearer store-key-123" }))).toBeNull();
    expect(readStoreKey(new Headers({ "x-haggleboard-store-key": "store-key-123" }))).toBe("store-key-123");
    await expect(submitBid({ store_domain: "example-run.test", product_url: "http://example-run.test/p", price: 10, currency: "USD" }, "x".repeat(43), deps)).rejects.toThrow(/https/);
    await expect(
      submitBid(
        {
          store_domain: "example-run.test",
          product_url: "https://example-run.test/products/ghost?variant=9",
          price: 90,
          currency: "usd",
          brand: "Brooks",
          model: "Ghost 16",
          gender: "women",
          size: "8",
        },
        "short",
        deps,
      ),
    ).rejects.toThrow(/store key/i);

    const issued = await issueStoreKey("example-run.test", deps);
    expect(issued).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const bid = await submitBid(
      {
        store_domain: "example-run.test",
        product_url: "https://example-run.test/products/ghost?variant=9",
        price: 90,
        currency: "usd",
        brand: "Brooks",
        model: "Ghost 16",
        gender: "women",
        size: "8",
        shipping: "free over $50",
        returns_days: 30,
        request_id: posted.id,
      },
      issued,
      deps,
    );
    expect(bid.auth).toBe("verified");
    expect(bid.offer.verified).toBe(true);
    expect(bid.offer.checkout).toBe("store_site");
    await expect(
      submitBid(
        {
          store_domain: "example-run.test",
          product_url: "https://example-run.test/products/ghost?variant=9",
          price: 10,
          currency: "usd",
          brand: "Brooks",
          model: "Ghost 16",
          gender: "women",
          size: "8",
        },
        `${issued}no`,
        deps,
      ),
    ).rejects.toThrow(/does not match/);
    await store.saveBid({
      id: "unverified-bid",
      request_id: posted.id,
      store_domain: "example-run.test",
      key_hash: "00",
      bid_json: JSON.stringify({
        id: "unverified-bid",
        store_domain: "example-run.test",
        product_url: "https://example-run.test/products/ghost?variant=1",
        price: 10,
        currency: "USD",
        brand: "Brooks",
        model: "Ghost 16",
        gender: "women",
        size: "8",
        verified: false,
      }),
      created_at: "2026-10-18T00:00:00.000Z",
    });
    const withBid = await getOffers({ request_id: posted.id }, deps);
    expect(withBid.offers[0]?.source).toBe("bid");
    expect(withBid.offers[0]?.price_cents).toBe(9000);
    expect(withBid.offers[0]?.shipping).toBe("free over $50");
    expect(withBid.offers.some((offer) => offer.verified === false)).toBe(false);
    expect(publicNeedLabel({ ...posted.need, text: "call me at home" })).not.toContain("call me");
    const reviewed = await reportNeed(posted.id, { reason: "please remove", ipHash: "hashed-ip", deleteToken: null }, deps);
    expect(reviewed).toEqual({ status: "review", hidden: false });
    expect(JSON.stringify(await store.listReports())).not.toContain("call me");
    const stillListed = await getOffers({ request_id: posted.id }, deps);
    expect(stillListed.offers.some((offer) => offer.source === "bid" && offer.verified === true)).toBe(true);
    expect(stillListed.offers.some((offer) => offer.verified === false)).toBe(false);
    if (previousEnabled === undefined) delete process.env.BID_KEYS_ENABLED;
    else process.env.BID_KEYS_ENABLED = previousEnabled;
    if (previousSigning === undefined) delete process.env.BID_TOKEN_SIGNING_KEY;
    else process.env.BID_TOKEN_SIGNING_KEY = previousSigning;

    const search = await searchProducts({ query: "Hoka Clifton 9", size: "10" }, deps);
    expect(search.products[0]?.product_url).toContain("hoka-clifton-9");
    await store.close();
  });
});

describe("reports", () => {
  it("does not remove a request after one report without the delete token", async () => {
    const store = await openSqlite();
    const deps: Deps = { store, loadVariants: async () => [] };
    const posted = await postRequest({ text: "women's Brooks Ghost 16, size 8" }, deps);
    expect(posted.delete_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await store.getRequest(posted.id);
    expect(row?.delete_token_hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.delete_token_hmac).not.toContain(posted.delete_token);

    const once = await reportNeed(posted.id, { reason: "spam", ipHash: "ip-a", deleteToken: null }, deps);
    expect(once).toEqual({ status: "review", hidden: false });
    const again = await reportNeed(posted.id, { reason: "spam", ipHash: "ip-a", deleteToken: null }, deps);
    expect(again).toEqual({ status: "review", hidden: false });
    expect(await store.countReporters(posted.id)).toBe(1);
    await expect(getOffers({ request_id: posted.id }, deps)).resolves.toMatchObject({ need: posted.need });
    await store.close();
  });

  it("hides immediately with the delete token and leaves the daily auto-hide count unchanged", async () => {
    const store = await openSqlite();
    const deps: Deps = { store, loadVariants: async () => [] };
    const posted = await postRequest({ text: "women's Brooks Ghost 16, size 8" }, deps);
    const hidden = await reportNeed(
      posted.id,
      { reason: "", ipHash: "ip-a", deleteToken: posted.delete_token },
      deps,
    );
    expect(hidden).toEqual({ status: "hidden", hidden: true });
    expect(await store.countAutoHidesSince("1970-01-01T00:00:00.000Z")).toBe(0);
    await expect(getOffers({ request_id: posted.id }, deps)).rejects.toThrow(/No stored/);
    await store.close();
  });

  it("hides after three distinct hashed IPs and stops auto-hides after 20 in a day", async () => {
    const store = await openSqlite();
    const deps: Deps = { store, loadVariants: async () => [] };
    const now = Date.parse("2026-10-18T12:00:00.000Z");
    for (let i = 0; i < 20; i++) {
      const posted = await postRequest({ text: "women's Brooks Ghost 16, size 8" }, deps);
      let last: { status: "review" | "hidden"; hidden: boolean } = { status: "review", hidden: false };
      for (const ip of ["a", "b", "c"]) {
        last = await reportNeed(posted.id, { reason: "spam", ipHash: `${ip}-${i}`, deleteToken: null }, deps, now);
      }
      expect(last).toEqual({ status: "hidden", hidden: true });
    }
    const extra = await postRequest({ text: "women's Brooks Ghost 16, size 8" }, deps);
    let held: { status: "review" | "hidden"; hidden: boolean } = { status: "review", hidden: false };
    for (const ip of ["a", "b", "c"]) {
      held = await reportNeed(extra.id, { reason: "spam", ipHash: `held-${ip}`, deleteToken: null }, deps, now);
    }
    expect(held).toEqual({ status: "review", hidden: false });
    await expect(getOffers({ request_id: extra.id }, deps)).resolves.toMatchObject({ need: extra.need });
    expect(await store.countAutoHidesSince(new Date(now - 24 * 60 * 60 * 1000).toISOString())).toBe(20);
    await store.close();
  });
});

describe("bids flag", () => {
  it("treats BID_KEYS_ENABLED=0 as off", () => {
    const env = (value?: string): NodeJS.ProcessEnv =>
      ({ BID_KEYS_ENABLED: value }) as unknown as NodeJS.ProcessEnv;
    expect(bidsEnabled(env("0"))).toBe(false);
    expect(bidsEnabled(env("false"))).toBe(false);
    expect(bidsEnabled(env())).toBe(false);
    expect(bidsEnabled(env("1"))).toBe(true);
    expect(bidsEnabled(env("yes"))).toBe(true);
  });
});

describe("rate limit", () => {
  it("stores a hash in the database and returns retry-after after 10 writes in a minute", async () => {
    const store = await openSqlite();
    const hashed = hashIp("203.0.113.8", "salt");
    expect(hashed).not.toContain("203.0.113.8");
    const now = 1_700_000_000_000;
    const counter = { bump: (ipHash: string, windowKey: string) => store.bumpRate(ipHash, windowKey) };
    for (let i = 0; i < 10; i++) expect((await takeRateLimit(hashed, now, counter)).ok).toBe(true);
    const blocked = await takeRateLimit(hashed, now, counter);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.retryAfter).toBeGreaterThan(0);
    const day = await takeRateLimit(hashIp("203.0.113.9", "salt"), now, counter);
    expect(day.ok).toBe(true);
    await store.close();
  });

  it("reads x-vercel-forwarded-for, then x-real-ip, and ignores x-forwarded-for", () => {
    const request = (headers: Record<string, string>) => new Request("http://haggleboard.test/", { headers });
    expect(
      clientIp(
        request({
          "x-vercel-forwarded-for": "198.51.100.8, 10.0.0.1",
          "x-real-ip": "203.0.113.1",
          "x-forwarded-for": "1.2.3.4",
        }),
      ),
    ).toBe("198.51.100.8");
    expect(clientIp(request({ "x-real-ip": "203.0.113.1", "x-forwarded-for": "1.2.3.4" }))).toBe("203.0.113.1");
    expect(clientIp(request({ "x-forwarded-for": "1.2.3.4" }))).toBe("unknown");
  });
});

describe("mcp", () => {
  it("answers get_offers over streamable HTTP", async () => {
    const store = await openSqlite();
    const variants: CatalogVariant[] = readFixture(path.join(process.cwd(), "fixtures", "mini-catalog.json")).variants;
    const deps: Deps = { store, loadVariants: async () => variants };
    const call = async (method: string, params: unknown, id: number) => {
      const response = await handleMcpRequest(
        new Request("http://haggleboard.test/api/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        }),
        deps,
      );
      return { status: response.status, body: await response.json() };
    };

    const init = await call(
      "initialize",
      { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      1,
    );
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe("haggleboard");

    const tools = await call("tools/list", {}, 2);
    const names = tools.body.result.tools.map((tool: { name: string }) => tool.name).sort();
    expect(names).toEqual(["get_offers", "post_request", "search_products"]);

    const offers = await call(
      "tools/call",
      { name: "get_offers", arguments: { text: "women's Brooks Ghost 16, size 8, under $130" } },
      3,
    );
    expect(offers.status).toBe(200);
    const payload = JSON.parse(offers.body.result.content[0].text);
    expect(payload.offers[0].product_url).toBe("https://example-run.test/products/brooks-ghost-16?variant=1");
    expect(payload.offers[0].checkout).toBe("store_site");
    expect(payload.disclaimer).toMatch(/not affiliated/i);
    await store.close();
  });
});
