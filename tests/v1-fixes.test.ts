import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Arena } from "../components/arena/arena";
import { parseAgentCatalog, agentQuery } from "../feeds/agent-catalog";
import { USER_AGENT } from "../feeds/constants";
import { arenaStateAt, type PublicArenaEvent, type PublicBidder } from "../lib/arena";
import { feedToArena } from "../lib/arena-live";
import { eventsWithLazyClose, isStale, posterAuction, STALE_AFTER_DAYS } from "../lib/auction";
import { openPglite, type Store } from "../lib/db";
import { requestEvents, type EventContext } from "../lib/events";
import { postRequest, recordOffers, variantOffer, withdrawOffer, type Deps } from "../lib/service";
import { sitemapEntries } from "../lib/sitemap";
import { publicStats } from "../lib/stats";
import { publicStream } from "../lib/stream";
import type { CatalogVariant } from "../referee/types";
import { agentRouteOf, clearArcCache, createArcClient } from "../watcher/arc";
import { chooseCandidates } from "../watcher/candidates";
import { brandVerdict, learnBrandIndex, learnStoreRecord, storeIsCold, storesWithHits } from "../watcher/learned";
import { runWatch } from "../watcher/run";
import { TEST_STORE_DOMAINS, testSchedule, testStoresEnabled, testStoreStep } from "../watcher/test-stores";

process.env.DELETE_TOKEN_KEY ||= "test-delete-token-key";

const DAY = 86_400_000;
const outside: EventContext = {
  agent: { agent_class: "claude-user", kind: "assistant", signature_agent: null, signature_verified: false },
  internal: false,
  caller_hash: "d".repeat(64),
  channel: "api",
};

/** A made-up catalog: brand "Larkspur", model "Glider 3", two stores, observed `daysAgo` days ago. */
function variant(domain: string, cents: number, daysAgo: number, available = true): CatalogVariant {
  return {
    id: `${domain}:1`,
    store_domain: domain,
    shop_origin: `https://${domain}`,
    country: "US",
    region: "US",
    brand: "Larkspur",
    model: "Glider 3",
    title: "Larkspur Glider 3",
    gender: "women",
    size: "8",
    size_raw: "8",
    size_system: "US",
    size_men: null,
    size_women: null,
    width: null,
    color: null,
    available,
    price: (cents / 100).toFixed(2),
    price_cents: cents,
    compare_at_price: null,
    compare_at_cents: null,
    currency: "USD",
    product_url: `https://${domain}/products/glider-3?variant=1`,
    handle: "glider-3",
    external_product_id: "1",
    external_variant_id: "1",
    category: "shoe",
    observed_at: new Date(Date.now() - daysAgo * DAY).toISOString(),
  };
}

const glider = { brand: "Larkspur", model: "Glider 3", gender: "women", size: "8", category: "running shoes" };

async function open(variants: CatalogVariant[], context?: EventContext): Promise<{ store: Store; deps: Deps }> {
  const store = await openPglite();
  return { store, deps: { store, loadVariants: async () => variants, context } };
}

describe("1. a stale price must not win", () => {
  it("withdraws a snapshot offer when a live read finds the item gone, and it can no longer win", async () => {
    // The 18 Oct case: the cheapest snapshot store no longer lists it; a live read confirms another store.
    const { store, deps } = await open([variant("old-cheap.test", 9_000, 35), variant("live-shop.test", 12_000, 35)], outside);
    const posted = await postRequest({ ...glider, auction_seconds: 30 }, deps);
    const opened = Date.parse(posted.created_at);
    let events = await requestEvents(store, posted.id);
    expect(events.filter((e) => e.type === "lead.changed").map((e) => e.store_domain)).toEqual(["old-cheap.test"]);

    expect(await withdrawOffer(store, posted.id, "old-cheap.test", "not_found", opened + 3_000)).toBe(true);
    await recordOffers(store, posted.id, [variantOffer({ ...variant("live-shop.test", 12_000, 0) }, "watcher")], { now: opened + 4_000 });
    events = await requestEvents(store, posted.id);
    const withdrawn = events.find((e) => e.type === "offer.withdrawn")!;
    expect(withdrawn.public).toMatchObject({ reason: "not_found", label: "no longer listed" });

    const closed = (await eventsWithLazyClose(store, posted.id, { now: opened + 40_000 })).find((e) => e.type === "auction.closed")!;
    expect(closed.public).toMatchObject({ winner: { store: "live-shop.test", confirmed: true }, result: "won" });

    const stream = (await publicStream(store, posted.id, opened + 40_000))!;
    expect(stream.events.some((e) => e.type === "store.withdrawn" && e.store === "old-cheap.test")).toBe(true);
    const arena = feedToArena(stream);
    expect(arena.bidders.find((b) => b.id === "old-cheap.test")?.priceNote).toBe("no longer listed");
    // The public prices list on the request page drops the withdrawn store's snapshot too.
    const { getOffers } = await import("../lib/service");
    const pub = await getOffers({ request_id: posted.id }, deps);
    expect(pub.offers.map((o) => o.store_domain)).not.toContain("old-cheap.test");
    await store.close();
  });

  it("ranks a live-confirmed price above an unconfirmed one at the same amount, and dates every offer", async () => {
    const { store, deps } = await open([variant("snap-shop.test", 10_000, 1)], outside);
    const posted = await postRequest({ ...glider, auction_seconds: 30 }, deps);
    const opened = Date.parse(posted.created_at);
    await recordOffers(store, posted.id, [variantOffer(variant("live-shop.test", 10_000, 0), "watcher")], { now: opened + 2_000 });
    const events = await requestEvents(store, posted.id);
    const leads = events.filter((e) => e.type === "lead.changed").map((e) => e.store_domain);
    expect(leads).toEqual(["snap-shop.test", "live-shop.test"]);
    const view = posterAuction(events, opened + 5_000)!;
    expect(view.standing.map((s) => [s.store_domain, s.confirmed])).toEqual([
      ["live-shop.test", true],
      ["snap-shop.test", false],
    ]);
    expect(view.standing.every((s) => typeof s.observed_at === "string")).toBe(true);
    const stream = (await publicStream(store, posted.id, opened + 5_000))!;
    for (const e of stream.events) if (e.type === "store.joined" && e.source === "public_price") expect(e.observed_at).toBeTruthy();
    await store.close();
  });

  it(`a snapshot older than ${STALE_AFTER_DAYS} days cannot win while a confirmed offer exists`, async () => {
    const { store, deps } = await open([variant("stale-cheap.test", 8_000, 30)], outside);
    const posted = await postRequest({ ...glider, auction_seconds: 30 }, deps);
    const opened = Date.parse(posted.created_at);
    await recordOffers(store, posted.id, [variantOffer(variant("live-shop.test", 11_000, 0), "watcher")], { now: opened + 2_000 });
    const events = await eventsWithLazyClose(store, posted.id, { now: opened + 40_000 });
    const closed = events.find((e) => e.type === "auction.closed")!;
    expect(closed.public).toMatchObject({ winner: { store: "live-shop.test" }, result: "won" });
    const view = posterAuction(events)!;
    const stale = view.standing.find((s) => s.store_domain === "stale-cheap.test")!;
    expect(stale).toMatchObject({ stale: true, confirmed: false });
    expect(isStale({ confirmed: false, observed_at: new Date(opened - 8 * DAY).toISOString() }, opened)).toBe(true);
    expect(isStale({ confirmed: false, observed_at: new Date(opened - 6 * DAY).toISOString() }, opened)).toBe(false);
    await store.close();
  });

  it("with only unconfirmed offers the result says so plainly, never 'Won', and stats do not count it as a win", async () => {
    const { store, deps } = await open([variant("stale-a.test", 9_000, 30), variant("stale-b.test", 9_500, 30)], outside);
    const posted = await postRequest({ ...glider, auction_seconds: 30 }, deps);
    const opened = Date.parse(posted.created_at);
    const closed = (await eventsWithLazyClose(store, posted.id, { now: opened + 40_000 })).find((e) => e.type === "auction.closed")!;
    expect(closed.public).toMatchObject({
      winner: { store: "stale-a.test", confirmed: false },
      result: "last_seen",
      result_label: "Best last-seen price, not confirmed today",
    });
    const stream = (await publicStream(store, posted.id, opened + 40_000))!;
    const arena = feedToArena(stream);
    expect(arena.result).toMatchObject({ kind: "last_seen" });
    const html = renderToStaticMarkup(
      h(Arena, { request: arena.request, durationSec: 30, bidders: arena.bidders, events: arena.events, demo: false, variant: "full", startStatic: true }),
    );
    expect(html).toContain("Best last-seen price, not confirmed today");
    expect(html).toContain("last seen");
    const stats = await publicStats(store, opened + 60_000);
    expect(stats.auctions_last_seen_only.value).toBe(1);
    expect(stats.winner_beat_best_public_price.closed_with_winner).toBe(0);
    await store.close();
  });

  it("the watcher withdraws a snapshot store whose live feed no longer lists the item", async () => {
    clearArcCache();
    const snapshot = [variant("seed-gone.example.com", 9_000, 30), variant("seed-other.example.com", 9_900, 30)];
    const { store, deps } = await open(snapshot, outside);
    const posted = await postRequest({ ...glider, auction_seconds: 120 }, deps);
    const clock = { t: Date.parse(posted.created_at) + 1_000 };
    const fetch = async (url: string): Promise<Response> => {
      const u = new URL(url);
      if (u.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /admin\n", { headers: { "content-type": "text/plain" } });
      if (u.pathname === "/products.json") return Response.json({ products: [] });
      return new Response("no", { status: 404 });
    };
    const result = await runWatch(store, { id: posted.id, need: posted.need, origin: "outside" }, deps.loadVariants, {
      fetch,
      arc: null,
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms;
      },
      cacheDir: mkdtempSync(path.join(tmpdir(), "hb-v1-cache-")),
      removed: new Set(),
      seeds: [{ domain: "seed-gone.example.com", region: "US", country: "US", currency: "USD" }],
      queuePath: path.join(mkdtempSync(path.join(tmpdir(), "hb-v1-q-")), "queue.json"),
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result.ran).toBe(true);
    const events = await requestEvents(store, posted.id);
    expect(events.find((e) => e.type === "store.read")?.public).toMatchObject({ outcome: "not_found", route: "feed", brand: "Larkspur" });
    expect(events.find((e) => e.type === "offer.withdrawn")).toMatchObject({ store_domain: "seed-gone.example.com" });
    // It was leading; the lead moves to the next store.
    expect(events.filter((e) => e.type === "lead.changed").at(-1)?.store_domain).toBe("seed-other.example.com");
    await store.close();
  });
});

describe("2. find the product: agent routes and the learned index", () => {
  it("reads ARC's agent route: UCP MCP with search_catalog first, never another host", () => {
    expect(
      agentRouteOf("shop.example", [
        { route: "storefront_mcp", status: "works", endpoint: "https://shop.example/api/mcp", catalog_tool: "search_catalog" },
        { route: "ucp_mcp", status: "works", endpoint: "https://www.shop.example/api/ucp/mcp", catalog_tool: "search_catalog" },
      ]),
    ).toEqual({ route: "ucp_mcp", endpoint: "https://www.shop.example/api/ucp/mcp", tool: "search_catalog" });
    // Shopify moved the catalog off /api/mcp: a storefront route counts only with search_shop_catalog.
    expect(agentRouteOf("shop.example", [{ route: "storefront_mcp", status: "works", endpoint: "https://shop.example/api/mcp", catalog_tool: "search_catalog" }])).toBeNull();
    expect(agentRouteOf("shop.example", [{ route: "ucp_mcp", status: "works", endpoint: "https://elsewhere.example/api/ucp/mcp", catalog_tool: "search_catalog" }])).toBeNull();
    expect(agentRouteOf("shop.example", [{ route: "ucp_mcp", status: "not_working", endpoint: "https://shop.example/api/ucp/mcp", catalog_tool: "search_catalog" }])).toBeNull();
  });

  it("parses a catalog search answer (the shape stores really return) into priced, sized variants", () => {
    const answer = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              products: [
                {
                  id: "gid://shopify/Product/101",
                  title: "Women's Glider 3",
                  url: "https://www.larkspur-run.example/products/womens-glider-3",
                  handle: "womens-glider-3",
                  description: { html: "The Larkspur Glider 3 is a light daily trainer." },
                  variants: [
                    { id: "gid://shopify/ProductVariant/1", title: "7", price: { amount: 13000, currency: "EUR" }, availability: { available: false }, options: [{ name: "Size", label: "7" }] },
                    { id: "gid://shopify/ProductVariant/2", title: "8", price: { amount: 13000, currency: "EUR" }, availability: { available: true }, options: [{ name: "Size", label: "8" }] },
                  ],
                },
                { id: "gid://shopify/Product/9", title: "Off-site", url: "https://other.example/p", variants: [] },
              ],
            }),
          },
        ],
      },
    };
    const variants = parseAgentCatalog(answer, {
      domain: "larkspur-run.example",
      fallbackCurrency: "USD",
      observedAt: "2026-11-23T00:00:00.000Z",
      brandHint: "Larkspur",
      official: false,
    });
    expect(variants).toHaveLength(2);
    expect(variants[1]).toMatchObject({
      brand: "Larkspur",
      size: "8",
      available: true,
      price: "130.00",
      price_cents: 13_000,
      currency: "EUR",
      product_url: "https://www.larkspur-run.example/products/womens-glider-3?variant=2",
    });
    expect(agentQuery({ brand: "Larkspur", model: "Glider 3", gender: "women" })).toBe("womens Larkspur Glider 3");
  });

  it("asks the store's own catalog search politely: robots first, bot user agent, one search, route logged", async () => {
    clearArcCache();
    const { store, deps } = await open([], outside);
    const posted = await postRequest({ ...glider, auction_seconds: 120 }, deps);
    const log: Array<{ url: string; ua: string | null; method: string; body: string | null }> = [];
    const clock = { t: Date.now() };
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
      const headers = new Headers(init.headers);
      log.push({ url, ua: headers.get("user-agent"), method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : null });
      const u = new URL(url);
      if (u.hostname === "www.arcreport.ai" && u.pathname === "/api/ask") {
        return Response.json({ result: { content: [{ text: JSON.stringify({ stores: [{ host: "glider-shop.example.com" }] }) }] } });
      }
      if (u.hostname === "www.arcreport.ai") {
        return Response.json({
          results: [
            {
              host: "glider-shop.example.com",
              known: true,
              reachable_checkout: true,
              rails: [],
              routes: [{ route: "ucp_mcp", status: "works", endpoint: "https://www.glider-shop.example.com/api/ucp/mcp", catalog_tool: "search_catalog" }],
            },
          ],
        });
      }
      if (u.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /checkout\n", { headers: { "content-type": "text/plain" } });
      if (u.pathname === "/api/ucp/mcp") {
        const text = JSON.stringify({
          products: [
            {
              id: "gid://shopify/Product/5",
              title: "Women's Glider 3",
              url: "https://www.glider-shop.example.com/products/womens-glider-3",
              description: { html: "The Larkspur Glider 3, a light daily trainer." },
              variants: [{ id: "gid://shopify/ProductVariant/55", title: "8", price: { amount: 12500, currency: "USD" }, availability: { available: true }, options: [{ name: "Size", label: "8" }] }],
            },
          ],
        });
        return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });
      }
      return new Response("no", { status: 404 });
    };
    const result = await runWatch(store, { id: posted.id, need: posted.need, origin: "outside" }, deps.loadVariants, {
      fetch,
      arc: createArcClient({ fetch, now: () => clock.t }),
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms;
      },
      cacheDir: mkdtempSync(path.join(tmpdir(), "hb-v1-cache-")),
      removed: new Set(),
      seeds: [],
      queuePath: path.join(mkdtempSync(path.join(tmpdir(), "hb-v1-q-")), "queue.json"),
      env: {} as NodeJS.ProcessEnv,
    });
    const toStore = log.filter((entry) => entry.url.includes("glider-shop.example.com"));
    expect(toStore.map((e) => [e.method, new URL(e.url).pathname])).toEqual([
      ["GET", "/robots.txt"],
      ["POST", "/api/ucp/mcp"],
    ]);
    expect(toStore.every((e) => e.ua === USER_AGENT)).toBe(true);
    const body = JSON.parse(toStore[1]!.body!) as { params: { name: string; arguments: { catalog: { query: string } } } };
    expect(body.params.name).toBe("search_catalog");
    expect(body.params.arguments.catalog.query).toBe("womens Larkspur Glider 3");
    expect(result.summary!.stores.find((s) => s.store_domain === "glider-shop.example.com")).toMatchObject({ status: "answered", route: "ucp_mcp" });
    const read = (await requestEvents(store, posted.id)).find((e) => e.type === "store.read")!;
    expect(read.public).toMatchObject({ outcome: "found", route: "ucp_mcp", brand: "Larkspur", public_price: "125.00" });
    await store.close();
  });

  it("skips the search when robots.txt disallows the endpoint, and backs off on 429", async () => {
    clearArcCache();
    for (const scenario of ["robots", "429"] as const) {
      const { store, deps } = await open([], outside);
      const posted = await postRequest({ ...glider, auction_seconds: 120 }, deps);
      const posts: string[] = [];
      const fetch = async (url: string, init: RequestInit): Promise<Response> => {
        const u = new URL(url);
        if (u.hostname === "www.arcreport.ai" && u.pathname === "/api/ask") return Response.json({ result: { content: [{ text: '{"stores":[{"host":"glider-shop.example.com"}]}' }] } });
        if (u.hostname === "www.arcreport.ai") {
          return Response.json({
            results: [{ host: "glider-shop.example.com", known: true, routes: [{ route: "ucp_mcp", status: "works", endpoint: "https://glider-shop.example.com/api/ucp/mcp", catalog_tool: "search_catalog" }] }],
          });
        }
        if (u.pathname === "/robots.txt") {
          return new Response(scenario === "robots" ? "User-agent: *\nDisallow: /api/\n" : "User-agent: *\nDisallow: /admin\n", { headers: { "content-type": "text/plain" } });
        }
        if (init.method === "POST") {
          posts.push(url);
          return new Response("", { status: 429 });
        }
        return new Response("no", { status: 404 });
      };
      const clock = { t: Date.now() };
      const result = await runWatch(store, { id: posted.id, need: posted.need, origin: "outside" }, deps.loadVariants, {
        fetch,
        arc: createArcClient({ fetch, now: () => clock.t }),
        now: () => clock.t,
        sleep: async (ms) => {
          clock.t += ms;
        },
        cacheDir: mkdtempSync(path.join(tmpdir(), "hb-v1-cache-")),
        removed: new Set(),
        seeds: [],
        queuePath: path.join(mkdtempSync(path.join(tmpdir(), "hb-v1-q-")), "queue.json"),
        env: {} as NodeJS.ProcessEnv,
      });
      const item = result.summary!.stores.find((s) => s.store_domain === "glider-shop.example.com")!;
      if (scenario === "robots") {
        expect(posts).toHaveLength(0);
        expect(item.reason).toMatch(/robots/);
      } else {
        expect(posts).toHaveLength(1);
        expect(item.reason).toMatch(/rate-limited/);
        const { getFetchState } = await import("../lib/watch-store");
        expect((await getFetchState(store, "glider-shop.example.com")).backoff_until).toBeTruthy();
      }
      await store.close();
    }
  });

  it("learns from its own reads: prefers stores with a hit for the brand, stops asking after repeated misses", async () => {
    const rows = [
      { store_domain: "hit.example.com", brand: "Larkspur", outcome: "found", at: "2026-11-20T00:00:00Z" },
      { store_domain: "miss.example.com", brand: "Larkspur", outcome: "not_found" },
      { store_domain: "miss.example.com", brand: "Larkspur", outcome: "not_found" },
      { store_domain: "once.example.com", brand: "Larkspur", outcome: "not_found" },
      { store_domain: "blocked.example.com", brand: "Larkspur", outcome: "blocked" },
      { store_domain: "miss.example.com", brand: "Other Brand", outcome: "found" },
      { store_domain: "cold.example.com", brand: "A", outcome: "not_found" },
      { store_domain: "cold.example.com", brand: "B", outcome: "not_found" },
      { store_domain: "cold.example.com", brand: "C", outcome: "not_found" },
    ];
    const index = learnBrandIndex(rows);
    expect(brandVerdict(index, "Larkspur", "hit.example.com")).toBe("hit");
    expect(brandVerdict(index, "larkspur", "www.miss.example.com")).toBe("avoid");
    expect(brandVerdict(index, "Larkspur", "once.example.com")).toBe("unknown");
    expect(brandVerdict(index, "Larkspur", "blocked.example.com")).toBe("unknown");
    expect(brandVerdict(index, "Other Brand", "miss.example.com")).toBe("hit");
    expect(storesWithHits(index, "Larkspur")).toEqual(["hit.example.com"]);
    const record = learnStoreRecord(rows);
    expect(storeIsCold(record, "cold.example.com")).toBe(true);
    expect(storeIsCold(record, "miss.example.com")).toBe(false);

    const candidates = await chooseCandidates(
      { brand: "Larkspur", model: "Glider 3", category: "running shoes" } as never,
      {
        arc: null,
        removed: new Set(),
        blocked: async () => null,
        variants: [],
        seeds: [
          { domain: "miss.example.com", region: "US", country: "US", currency: "USD" },
          { domain: "hit.example.com", region: "US", country: "US", currency: "USD" },
        ],
        learned: (domain) => brandVerdict(index, "Larkspur", domain),
        learnedHits: storesWithHits(index, "Larkspur"),
        cold: (domain) => storeIsCold(record, domain),
      },
    );
    expect(candidates[0]).toMatchObject({ domain: "hit.example.com", source: "learned", fetchable: true });
  });
});

describe("4. test arena (TEST_STORES=1, local only)", () => {
  it("is off by default and refused on the public production site", () => {
    expect(testStoresEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(testStoresEnabled({ TEST_STORES: "1" } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(testStoresEnabled({ TEST_STORES: "1", HB_PUBLIC: "1" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(testStoresEnabled({ TEST_STORES: "1", VERCEL_ENV: "production" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(TEST_STORE_DOMAINS.every((d) => d.endsWith(".example"))).toBe(true);
  });

  it("three made-up stores fight through the real engine, with a late lead change, all flagged test and internal", async () => {
    const { store, deps } = await open([variant("real-shop.example.com", 18_000, 1)], outside);
    const posted = await postRequest({ ...glider, auction_seconds: 120 }, deps);
    const opened = Date.parse(posted.created_at);
    for (const step of testSchedule()) {
      await testStoreStep(store, { id: posted.id, need: posted.need }, step.store, step.action === "join", opened + step.at_fraction * 120_000);
    }
    const events = await eventsWithLazyClose(store, posted.id, { now: opened + 125_000 });
    const leads = events.filter((e) => e.type === "lead.changed");
    expect(leads.length).toBeGreaterThanOrEqual(4);
    expect(new Set(leads.map((e) => e.store_domain)).size).toBeGreaterThanOrEqual(3);
    // No held order here, so the offers say nothing about one: their bands are shown.
    expect(leads.some((e) => String(e.public.band).startsWith("under_"))).toBe(true);
    // A lead change in the last part of the clock.
    expect(leads.some((e) => Date.parse(e.at) - opened >= 0.8 * 120_000)).toBe(true);
    const fromTests = events.filter((e) => e.store_domain && TEST_STORE_DOMAINS.includes(e.store_domain));
    expect(fromTests.length).toBeGreaterThan(0);
    for (const e of fromTests) {
      expect(e.internal).toBe(true);
      expect(e.public.test).toBe(true);
    }
    const closed = events.find((e) => e.type === "auction.closed")!;
    expect(closed.internal).toBe(true);
    expect(closed.public.test).toBe(true);
    // Bands are measured against every store's public price, including stores whose private offer beat their own.
    expect(closed.public.band).toMatch(/^under_/);
    // Private offers came from the store rules engine.
    expect(events.some((e) => e.type === "offer.made" && e.public.source === "private_offer" && e.public.via === "store_rule")).toBe(true);

    // Left out of stats and the sitemap, and the arena says "Test stores".
    const stats = await publicStats(store, opened + 130_000);
    expect(stats.auctions_closed.value).toBe(0);
    // Only the real snapshot store counts; the three test stores do not.
    expect(stats.stores_answering.value).toBe(1);
    const sitemap = await sitemapEntries(store, [], "https://haggleboard.com", opened + 130_000);
    expect(sitemap.some((entry) => entry.url.includes(posted.id))).toBe(false);
    const stream = (await publicStream(store, posted.id, opened + 130_000))!;
    expect(stream.test_stores).toBe(true);
    const arena = feedToArena(stream);
    expect(arena.testStores).toBe(true);
    const html = renderToStaticMarkup(
      h(Arena, { request: arena.request, durationSec: 120, bidders: arena.bidders, events: arena.events, demo: false, variant: "full", startStatic: true }),
    );
    expect(html).toContain("Test stores");
    expect(html).toContain("test store");
    await store.close();
  });
});

describe("5. small things", () => {
  it("a store that is no longer leading does not keep the band from when it last led", () => {
    const bidders: PublicBidder[] = [
      { id: "a", name: "Store A", tone: "clay" },
      { id: "b", name: "Store B", tone: "plum" },
    ];
    const events: PublicArenaEvent[] = [
      { kind: "join", at: 1, bidder: "a" },
      { kind: "lead", at: 2, bidder: "a", band: 10, label: "5 to 10% under" },
      { kind: "join", at: 3, bidder: "b" },
      { kind: "lead", at: 4, bidder: "b", band: 15, label: "10 to 20% under" },
    ];
    const state = arenaStateAt(events, bidders, 120, 10);
    const a = state.bidders.find((s) => s.bidder.id === "a")!;
    expect(a).toMatchObject({ leading: false, band: null, label: null, leads: 1 });
    expect(state.bidders.find((s) => s.bidder.id === "b")).toMatchObject({ leading: true, band: 15 });
    const html = renderToStaticMarkup(h(Arena, { request: "x", durationSec: 120, bidders, events, demo: true, variant: "full", startStatic: true }));
    expect(html).toContain("outbid");
  });
});
