import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL_INTERVAL_MS, USER_AGENT } from "../feeds/constants";
import { openPglite } from "../lib/db";
import { serviceContext } from "../lib/events";
import { requestOrigin } from "../lib/origin";
import { boardFeed, getOffers, issueStoreKey, postRequest, type Deps } from "../lib/service";
import { getFetchState } from "../lib/watch-store";
import { clearArcCache, createArcClient } from "../watcher/arc";
import {
  ARC_MAX_CALLS_PER_REQUEST,
  notifyStoresEnabled,
  storeRulesEnabled,
  WATCH_FEED_REQUESTS_PER_STORE,
  WATCH_MAX_STORE_FETCHES,
  WATCH_MAX_STORES,
  watcherInline,
} from "../watcher/constants";
import { listStoreNotifications, queueStoreNotifications } from "../watcher/notify";
import { runWatch, type WatchOptions } from "../watcher/run";
import { applyStoreRule, saveStoreRule, type StoreRule } from "../watcher/store-rules";
import type { CatalogVariant } from "../referee/types";

process.env.DELETE_TOKEN_KEY ||= "test-delete-token-key";

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

type StoreSpec = {
  shopify?: boolean;
  known?: boolean;
  robots?: string;
  robotsStatus?: number;
  productsStatus?: number;
  price?: string;
  redirect?: boolean;
  carries?: boolean;
};

type Logged = { url: string; at: number; ua: string | null; body: string | null };

/** A fake internet: ARC's two endpoints and a set of Shopify-like stores. */
function fakeWeb(stores: Record<string, StoreSpec>, arcHosts: string[], clock: { t: number }) {
  const log: Logged[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    log.push({ url, at: clock.t, ua: headers.get("user-agent"), body: typeof init.body === "string" ? init.body : null });
    const u = new URL(url);
    if (u.hostname === "www.arcreport.ai" && u.pathname === "/api/ask") {
      const text = JSON.stringify({
        stores: arcHosts.map((host) => ({ host, name: host, category: "footwear", grade: { grade: "A" } })),
      });
      return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });
    }
    if (u.hostname === "www.arcreport.ai" && u.pathname === "/api/precheck/bulk") {
      const { domains } = JSON.parse(String(init.body)) as { domains: string[] };
      return Response.json({
        results: domains.map((host) => {
          const spec = stores[host];
          return {
            host,
            known: spec?.known ?? Boolean(spec),
            reachable_checkout: spec?.shopify ? true : null,
            rails: [{ name: "Shop Pay", status: spec?.shopify ? "detected" : "not recorded" }],
            routes: [],
            price_check: spec?.shopify ? { currency: "USD" } : null,
          };
        }),
      });
    }
    const spec = stores[u.hostname];
    if (!spec) return new Response("no", { status: 404 });
    if (u.pathname === "/robots.txt") {
      if (spec.redirect) return new Response(null, { status: 301, headers: { location: `https://www.${u.hostname}/robots.txt` } });
      return new Response(spec.robots ?? "User-agent: *\nDisallow: /admin\n", {
        status: spec.robotsStatus ?? 200,
        headers: { "content-type": "text/plain" },
      });
    }
    if (u.pathname === "/products.json") {
      const status = spec.productsStatus ?? 200;
      if (status !== 200) return new Response("", { status });
      const products =
        spec.carries === false
          ? [{ id: 2, title: "Wool Runner", handle: "wool-runner", vendor: "Other", product_type: "Shoes", options: [{ name: "Size", position: 1 }], variants: [{ id: 21, option1: "8", price: "90.00", available: true }] }]
          : [
              {
                id: 1,
                title: "Women's Brooks Ghost 16",
                handle: "brooks-ghost-16",
                vendor: "Brooks",
                product_type: "Running Shoes",
                tags: ["womens"],
                options: [{ name: "Size", position: 1 }],
                variants: [{ id: 11, option1: "8", price: spec.price ?? "124.00", available: true }],
              },
            ];
      return Response.json({ products });
    }
    return new Response("no", { status: 404 });
  };
  return { fetch, log };
}

const need = { brand: "Brooks", model: "Ghost 16", gender: "women", size: "8" } as const;

async function setup(stores: Record<string, StoreSpec>, arcHosts: string[], extra: Partial<WatchOptions> = {}) {
  clearArcCache();
  const store = await openPglite();
  const deps: Deps = { store, loadVariants: async () => [] };
  const clock = { t: Date.now() };
  const web = fakeWeb(stores, arcHosts, clock);
  const waits: number[] = [];
  const opts: WatchOptions = {
    fetch: web.fetch,
    now: () => clock.t,
    sleep: async (ms) => {
      waits.push(ms);
      clock.t += ms;
    },
    cacheDir: mkdtempSync(path.join(tmpdir(), "hb-watch-cache-")),
    removed: new Set(),
    seeds: [],
    queuePath: path.join(mkdtempSync(path.join(tmpdir(), "hb-watch-q-")), "queue.json"),
    env: {} as NodeJS.ProcessEnv,
    ...extra,
  };
  const watch = async (posted: { id: string; need: unknown }, origin: "outside" | "test" | "internal" = "test", more: Partial<WatchOptions> = {}) =>
    runWatch(store, { id: posted.id, need: posted.need as never, origin }, deps.loadVariants, { ...opts, arc: createArcClient({ fetch: web.fetch, now: () => clock.t }), ...more });
  return { store, deps, web, waits, clock, opts, watch };
}

const storeFetches = (log: Logged[]) => log.filter((entry) => !entry.url.includes("arcreport.ai"));

describe("flags are off by default", () => {
  it("leaves inline watching, store rules and notifications off with no env", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(watcherInline(env)).toBe(false);
    expect(storeRulesEnabled(env)).toBe(false);
    expect(notifyStoresEnabled(env)).toBe(false);
    expect(storeRulesEnabled({ STORE_RULES_ENABLED: "0" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(notifyStoresEnabled({ NOTIFY_STORES_ENABLED: "yes" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });

  it("ships no sending code and no email provider", () => {
    const pkg = readFileSync(path.join(process.cwd(), "package.json"), "utf8");
    expect(pkg).not.toMatch(/nodemailer|resend|sendgrid|postmark|mailgun|@aws-sdk\/client-ses|smtp/i);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) files.push(full);
      }
    };
    for (const dir of ["app", "lib", "watcher", "feeds", "mcp"]) walk(path.join(process.cwd(), dir));
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/nodemailer|sendMail|api\.resend|sendgrid|postmark|mailgun|smtp:\/\//i);
    }
  });
});

describe("the watcher", () => {
  beforeEach(() => clearArcCache());

  it("never fetches more than the fixed cap for one request", async () => {
    const stores: Record<string, StoreSpec> = { "brooksrunning.com": { known: true, shopify: false } };
    const arcHosts: string[] = [];
    for (let i = 0; i < 12; i++) {
      stores[`shop${i}.com`] = { shopify: true };
      arcHosts.push(`shop${i}.com`);
    }
    const { deps, web, watch } = await setup(stores, arcHosts);
    const posted = await postRequest(need, deps);
    const result = await watch(posted);
    const fetched = storeFetches(web.log);
    expect(WATCH_MAX_STORES).toBe(5);
    expect(WATCH_FEED_REQUESTS_PER_STORE).toBe(1);
    expect(fetched.length).toBeLessThanOrEqual(WATCH_MAX_STORE_FETCHES);
    expect(result.summary!.store_fetches).toBe(fetched.length);
    const hosts = new Set(fetched.map((entry) => new URL(entry.url).hostname));
    expect(hosts.size).toBeLessThanOrEqual(WATCH_MAX_STORES);
    for (const host of hosts) {
      expect(fetched.filter((entry) => entry.url.includes(host) && entry.url.includes("/products.json"))).toHaveLength(1);
    }
    // 12 ARC category stores: 2 are tried (ARC_EXPLORE_PER_REQUEST), the other 10 are not asked.
    expect(result.summary!.stores.filter((item) => item.reason?.includes("untried category stores")).length).toBe(10);
    expect(result.summary!.stores.find((item) => item.store_domain === "brooksrunning.com")?.reason).toMatch(/no public product feed/);
    expect(web.log.filter((entry) => entry.url.includes("arcreport.ai")).length).toBeLessThanOrEqual(ARC_MAX_CALLS_PER_REQUEST);
  });

  it("refuses a second request to a store, so a redirect is skipped, not followed", async () => {
    const { deps, web, watch } = await setup({ "redirecting.com": { shopify: true, redirect: true } }, ["redirecting.com"]);
    const result = await watch(await postRequest(need, deps));
    const mine = storeFetches(web.log).filter((entry) => entry.url.includes("redirecting.com"));
    expect(mine.length).toBeLessThanOrEqual(2);
    expect(mine.some((entry) => entry.url.includes("/products.json"))).toBe(false);
    expect(result.summary!.stores.find((item) => item.store_domain === "redirecting.com")).toMatchObject({
      status: "skipped",
      reason: "would need more than one request (redirect)",
    });
  });

  it("reuses the crawler's politeness: bot user agent, robots.txt first, gaps, back-offs, removal list", async () => {
    const stores: Record<string, StoreSpec> = {
      "polite.com": { shopify: true },
      "norobots.com": { shopify: true, robots: "User-agent: HaggleBoard-bot\nDisallow: /\n" },
      "limited.com": { shopify: true, productsStatus: 429 },
      "removed-shop.com": { shopify: true },
      "second.com": { shopify: true },
    };
    const { deps, web, watch, store, clock } = await setup(stores, Object.keys(stores), { removed: new Set(["removed-shop.com"]), arcExplore: 5 });
    const result = await watch(await postRequest(need, deps));
    const fetched = storeFetches(web.log);
    for (const entry of fetched) expect(entry.ua).toBe(USER_AGENT);
    for (const entry of web.log.filter((e) => e.url.includes("arcreport.ai"))) expect(entry.ua).toBe(USER_AGENT);
    for (const host of new Set(fetched.map((entry) => new URL(entry.url).hostname))) {
      const urls = fetched.filter((entry) => new URL(entry.url).hostname === host).map((entry) => new URL(entry.url).pathname);
      expect(urls[0]).toBe("/robots.txt");
    }
    for (let i = 1; i < fetched.length; i++) {
      expect(fetched[i]!.at - fetched[i - 1]!.at).toBeGreaterThanOrEqual(DEFAULT_GLOBAL_INTERVAL_MS);
    }
    expect(fetched.some((entry) => entry.url.includes("norobots.com/products.json"))).toBe(false);
    expect(fetched.some((entry) => entry.url.includes("removed-shop.com"))).toBe(false);
    const byDomain = Object.fromEntries(result.summary!.stores.map((item) => [item.store_domain, item]));
    expect(byDomain["norobots.com"]?.reason).toMatch(/robots\.txt does not allow/);
    expect(byDomain["removed-shop.com"]?.reason).toMatch(/asked to be removed/);
    expect(byDomain["limited.com"]?.reason).toMatch(/rate-limited/);
    expect(byDomain["polite.com"]?.status).toBe("answered");
    const state = await getFetchState(store, "limited.com");
    expect(Date.parse(state.backoff_until!)).toBeGreaterThanOrEqual(clock.t + 23 * 3_600_000);

    // The back-off holds for the next request: limited.com is not fetched again.
    const before = storeFetches(web.log).length;
    const next = await watch(await postRequest(need, deps));
    expect(next.summary!.stores.find((item) => item.store_domain === "limited.com")?.reason).toMatch(/back-off/);
    expect(storeFetches(web.log).slice(before).some((entry) => entry.url.includes("limited.com"))).toBe(false);
  });

  it("labels what it finds as public feed prices with observed_at, and watches a request once", async () => {
    const { deps, watch } = await setup({ "polite.com": { shopify: true, price: "118.00" } }, ["polite.com"]);
    const posted = await postRequest({ ...need, holding: { seller: "Elsewhere Ltd", price: 130, currency: "USD", delivery_by: inDays(5) } }, deps);
    const result = await watch(posted);
    expect(result.offers).toHaveLength(1);
    expect((await watch(posted)).ran).toBe(false);
    const mine = await getOffers({ request_id: posted.id, delete_token: posted.delete_token }, deps);
    const offer = mine.offers.find((item) => item.store_domain === "polite.com")!;
    expect(offer.source).toBe("feed");
    expect(offer.price).toBe("118.00");
    expect(Number.isNaN(Date.parse(offer.observed_at))).toBe(false);
    expect(offer.vs_holding).toMatchObject({ beats: true, by: "12.00" });
    expect(mine.watch?.status).toBe("done");
    const theirs = await getOffers({ request_id: posted.id }, deps);
    expect(theirs.offers.find((item) => item.store_domain === "polite.com")?.vs_holding).toBeUndefined();
    const row = (await boardFeed(deps)).requests.find((item) => item.id === posted.id)!;
    expect(row.stores_answered).toBe(1);
    expect(row.outcome).toBe("answered");
    expect(JSON.stringify(row)).not.toContain("Elsewhere Ltd");
  });

  it("sends ARC product fields only, never the poster's text or holding, and caches ARC answers", async () => {
    const { deps, web, watch } = await setup({ "polite.com": { shopify: true } }, ["polite.com"]);
    const posted = await postRequest(
      { ...need, text: "PRIVATEWORDS women's Brooks Ghost 16 size 8", holding: { seller: "HeldSeller", price: 99.99, currency: "USD" } },
      deps,
    );
    await watch(posted);
    const arcBodies = web.log.filter((entry) => entry.url.includes("arcreport.ai")).map((entry) => entry.body ?? "");
    expect(arcBodies.length).toBe(2);
    for (const body of arcBodies) expect(body).not.toMatch(/PRIVATEWORDS|HeldSeller|99\.99/);
    const before = web.log.filter((entry) => entry.url.includes("arcreport.ai")).length;
    await watch(await postRequest(need, deps));
    expect(web.log.filter((entry) => entry.url.includes("arcreport.ai")).length).toBe(before);
  });
});

describe("store rules and private offers (off by default)", () => {
  const rule: StoreRule = {
    beat_by_up_to_percent: 10,
    floor: { price: 111.11, currency: "USD" },
    eligible: { brands: ["Brooks"] },
    offer_ttl_minutes: 30,
  };
  const onEnv = {
    STORE_RULES_ENABLED: "1",
    BID_KEYS_ENABLED: "1",
    BID_TOKEN_SIGNING_KEY: "test-signing-key",
  } as unknown as NodeJS.ProcessEnv;

  it("computes a private offer that beats the holding, never below the floor", () => {
    const variant = { price: "124.00", price_cents: 12400, currency: "USD", brand: "Brooks", product_url: "https://polite.com/products/g?variant=1", title: "Ghost 16", store_domain: "polite.com", size: "8", color: null } as CatalogVariant;
    const base = { holding: { seller: null, price_cents: 12000, currency: "USD", delivered: false, delivery_by: null }, quantity: 1, gtin: null } as never;
    const made = applyStoreRule(rule, variant, base, "req-1", Date.parse("2026-11-22T12:00:00Z"));
    expect(made.offer?.price).toBe("118.80");
    expect(made.offer?.expires_at).toBe("2026-11-22T12:30:00.000Z");
    expect(made.offer?.hbp).toMatchObject({ hbp: "0.1", type: "offer", round: 1, signature: null, terms: { price: { amount: "118.80", currency: "USD" } } });
    expect(JSON.stringify(made)).not.toContain("111.11");
    const low = applyStoreRule(rule, variant, { ...(base as object), holding: { seller: null, price_cents: 11000, currency: "USD", delivered: false, delivery_by: null } } as never, "req-1");
    expect(low.offer).toBeNull();
    const cheaper = applyStoreRule(rule, { ...variant, price_cents: 11500, price: "115.00" }, base, "req-1");
    expect(cheaper).toMatchObject({ offer: null, reason: "the public price already beats the held order" });
  });

  it("refuses to save a rule while the flag is off", async () => {
    const store = await openPglite();
    await expect(saveStoreRule({ store_domain: "polite.com", rule }, "k".repeat(43), store, {} as NodeJS.ProcessEnv)).rejects.toThrow(/off/);
    await store.close();
  });

  it("shows a private offer only to the poster, and never the floor", async () => {
    const { deps, watch, store } = await setup({ "polite.com": { shopify: true, price: "124.00" } }, ["polite.com"]);
    const previous = { ...process.env };
    Object.assign(process.env, onEnv);
    let key: string;
    try {
      key = await issueStoreKey("polite.com", deps);
      await expect(saveStoreRule({ store_domain: "polite.com", rule }, key, store, onEnv)).resolves.toEqual({ saved: true, store_domain: "polite.com" });
    } finally {
      process.env = previous;
    }
    const posted = await postRequest({ ...need, holding: { seller: "Elsewhere Ltd", price: 120, currency: "USD" } }, deps);

    // Flag off: no private offer.
    const off = await watch(posted, "outside", { env: {} as NodeJS.ProcessEnv });
    expect(off.private_offers).toBe(0);

    const posted2 = await postRequest({ ...need, holding: { seller: "Elsewhere Ltd", price: 120, currency: "USD" } }, deps);
    const on = await watch(posted2, "outside", { env: onEnv });
    expect(on.private_offers, JSON.stringify(on.summary)).toBe(1);

    const mine = await getOffers({ request_id: posted2.id, delete_token: posted2.delete_token }, deps);
    const priv = mine.offers.find((offer) => offer.source === "bid")!;
    expect(priv.price).toBe("118.80");
    expect(priv.note).toMatch(/Only you see it/);
    expect(priv.expires_at).toBeDefined();
    expect(JSON.stringify(mine)).not.toContain("111.11");

    const publicRead = JSON.stringify(await getOffers({ request_id: posted2.id }, deps));
    const feed = JSON.stringify(await boardFeed(deps));
    for (const surface of [publicRead, feed]) {
      expect(surface).not.toContain("118.80");
      expect(surface).not.toContain("111.11");
      expect(surface).not.toContain("hbp");
    }
    const { BoardList } = await import("../components/board-list");
    const { boardRows } = await import("../lib/service");
    const html = renderToStaticMarkup(BoardList({ rows: await boardRows(deps) }));
    expect(html).not.toContain("118.80");
    expect(html).not.toContain("111.11");
  });
});

describe("notify-store hook (off by default, never sends)", () => {
  it("queues nothing while the flag is off", async () => {
    const { deps, watch, store } = await setup({ "polite.com": { shopify: true } }, ["polite.com"]);
    const result = await watch(await postRequest(need, deps), "outside");
    expect(result.notifications.every((item) => !item.queued)).toBe(true);
    expect(await listStoreNotifications(store)).toEqual([]);
  });

  it("queues one row per unclaimed store for outside requests only, records the request, and dedupes", async () => {
    const on = { NOTIFY_STORES_ENABLED: "1" } as unknown as NodeJS.ProcessEnv;
    const { deps, watch, store } = await setup(
      { "polite.com": { shopify: true }, "other.com": { shopify: true, carries: false } },
      ["polite.com", "other.com"],
      { env: on },
    );
    const own = await postRequest(need, deps);
    expect((await watch(own, "test")).notifications.every((item) => !item.queued)).toBe(true);
    expect((await watch(await postRequest(need, deps), "internal")).notifications.every((item) => !item.queued)).toBe(true);
    expect(await listStoreNotifications(store)).toEqual([]);

    // Origin "outside" but marked internal in the event log (for example by HB_INTERNAL_KEYS): no queue.
    const keyed = await postRequest(need, deps);
    expect((await watch(keyed, "outside")).notifications.every((item) => !item.queued)).toBe(true);
    expect(await listStoreNotifications(store)).toEqual([]);

    const outside = { ...deps, context: { ...serviceContext(), internal: false } };
    const first = await postRequest(need, outside);
    const firstRun = await watch(first, "outside");
    expect(firstRun.notifications).toEqual([{ store_domain: "polite.com", queued: true, reason: "queued" }]);
    const second = await postRequest(need, outside);
    const secondRun = await watch(second, "outside");
    expect(secondRun.notifications).toEqual([{ store_domain: "polite.com", queued: false, reason: "already queued once" }]);
    const rows = await listStoreNotifications(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ store_domain: "polite.com", request_id: first.id, status: "queued" });
    expect(JSON.stringify(rows)).not.toMatch(/Brooks|Ghost|holding/);
  });

  it("skips stores on the removal list and stores that have claimed their listing", async () => {
    const store = await openPglite();
    const on = { NOTIFY_STORES_ENABLED: "1" } as unknown as NodeJS.ProcessEnv;
    await store.saveStoreKey({ store_domain: "claimed.com", key_hmac: "ab".repeat(32), created_at: new Date().toISOString() });
    const decisions = await queueStoreNotifications(
      store,
      { requestId: "r1", origin: "outside", storesCarrying: ["claimed.com", "gone.com", "fresh.com"] },
      on,
      new Set(["gone.com"]),
    );
    expect(decisions.map((item) => [item.store_domain, item.queued])).toEqual([
      ["claimed.com", false],
      ["gone.com", false],
      ["fresh.com", true],
    ]);
    await store.close();
  });

  it("tells our own requests from outside ones", () => {
    const none = {} as NodeJS.ProcessEnv;
    const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });
    expect(requestOrigin(req("https://haggleboard.com/api/requests"), { VITEST: "true" } as unknown as NodeJS.ProcessEnv)).toBe("test");
    expect(requestOrigin(req("https://haggleboard.com/api/requests"), { NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv)).toBe("test");
    expect(requestOrigin(req("http://localhost:3000/api/requests"), none)).toBe("test");
    expect(requestOrigin(req("https://haggleboard.test/api/requests"), none)).toBe("test");
    expect(requestOrigin(req("https://haggleboard.com/api/requests", { "x-haggleboard-origin": "test" }), none)).toBe("test");
    expect(requestOrigin(req("https://haggleboard.com/api/requests", { "x-haggleboard-origin": "internal" }), none)).toBe("internal");
    expect(requestOrigin(req("https://haggleboard.com/api/requests", { "user-agent": USER_AGENT }), none)).toBe("internal");
    expect(requestOrigin(req("https://haggleboard.com/api/requests", { "user-agent": "Mozilla/5.0" }), none)).toBe("outside");
  });
});
