import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { readFixture } from "../lib/catalog";
import { getStore, openPglite, type Store } from "../lib/db";
import type { EventContext } from "../lib/events";
import { DEDUPE_MS, nonCreatingReason } from "../lib/find";
import { indexNowEnabled, submitIndexNow } from "../lib/indexnow";
import { importVariants, postRequest, recordOffers, reportNeed, type Deps } from "../lib/service";
import { sitemapEntries } from "../lib/sitemap";
import { storePageData } from "../lib/store-page";
import type { CatalogVariant } from "../referee/types";

process.env.DATABASE_URL = "pglite://memory";
process.env.DELETE_TOKEN_KEY ||= "test-delete-token-key";

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const fixture = readFixture(path.join(process.cwd(), "fixtures", "mini-catalog.json")).variants;

let store: Store;
beforeAll(async () => {
  store = await getStore();
  await importVariants(fixture, store);
});

async function requestCount(): Promise<number> {
  return Number((await store.select("SELECT COUNT(*) AS n FROM requests"))[0]!.n);
}

function find(query: string, headers: Record<string, string> = {}, file = "find") {
  return new Request(`http://haggleboard.test/${file}?${query}`, { headers: { "x-real-ip": "198.51.100.77", ...headers } });
}

describe("one-address posting: /find", () => {
  it("creates a request, shows offers, the page link and the token once, and is never cached", async () => {
    const { GET } = await import("../app/find/route");
    const before = await requestCount();
    const response = await GET(find("q=women%27s+Brooks+Ghost+16+size+8", { "user-agent": "Claude-User/1.0" }));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("vercel-cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toMatch(/href="\/r\/[0-9a-f-]{36}"/);
    expect(html).toContain("Delete token");
    expect(html).toContain("119.95");
    expect(await requestCount()).toBe(before + 1);
  });

  it("returns the same request for the same q from the same caller, without the token again", async () => {
    const { GET } = await import("../app/find.json/route");
    const first = (await (await GET(find("q=Hoka+Clifton+9+mens+size+10", { "x-real-ip": "198.51.100.78" }, "find.json"))).json()) as {
      id: string;
      delete_token: string;
      created: boolean;
    };
    expect(first.created).toBe(true);
    expect(first.delete_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const before = await requestCount();
    const again = (await (await GET(find("q=hoka  clifton 9 MENS size 10", { "x-real-ip": "198.51.100.78" }, "find.json"))).json()) as Record<string, unknown>;
    expect(again).toMatchObject({ created: false, duplicate: true, request_id: first.id });
    expect(JSON.stringify(again)).not.toContain(first.delete_token);
    expect(await requestCount()).toBe(before);
    // Another caller, or another query, is a new request.
    const other = (await (await GET(find("q=Hoka+Clifton+9+mens+size+10", { "x-real-ip": "198.51.100.79" }, "find.json"))).json()) as { id: string };
    expect(other.id).not.toBe(first.id);
    expect(DEDUPE_MS).toBe(600_000);
  });

  it("answers JSON to Accept: application/json on /find", async () => {
    const { GET } = await import("../app/find/route");
    const response = await GET(find("q=Brooks+Ghost+16", { accept: "application/json", "x-real-ip": "198.51.100.80" }));
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as { created: boolean; board_url: string };
    expect(body.created).toBe(true);
    expect(body.board_url).toMatch(/^\/r\//);
  });

  it("never creates a request for link prefetches, crawlers or link previews", async () => {
    const { GET, HEAD } = await import("../app/find/route");
    const cases: Array<Record<string, string>> = [
      { "sec-purpose": "prefetch" },
      { "sec-purpose": "prefetch;prerender" },
      { purpose: "prefetch" },
      { "x-moz": "prefetch" },
      { "next-router-prefetch": "1" },
      { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
      { "user-agent": "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)" },
      { "user-agent": "Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)" },
      { "user-agent": "GPTBot/1.1" },
      { "user-agent": "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" },
      { "user-agent": "facebookexternalhit/1.1" },
      { "user-agent": "Twitterbot/1.0" },
    ];
    const before = await requestCount();
    for (const headers of cases) {
      const response = await GET(find("q=Brooks+Ghost+16+size+8", { ...headers, "x-real-ip": "198.51.100.81" }));
      expect(response.status, JSON.stringify(headers)).toBe(200);
      const html = await response.text();
      expect(html).toContain("Nothing was posted");
      expect(html).toContain("Ask your agent to haggle for it on HaggleBoard.");
    }
    const head = await HEAD(new Request("http://haggleboard.test/find?q=Brooks", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await requestCount()).toBe(before);
    expect(nonCreatingReason(new Request("http://x.test/find", { headers: { "user-agent": "ChatGPT-User/1.0" } }))).toBeNull();
  });

  it("explains how to post when q is missing, and applies the POST rate limit", async () => {
    const { GET } = await import("../app/find.json/route");
    const empty = (await (await GET(find("", {}, "find.json"))).json()) as { created: boolean; how: string };
    expect(empty.created).toBe(false);
    expect(empty.how).toContain("/find?q=");
    let last = 0;
    for (let i = 0; i < 11; i += 1) last = (await GET(find(`q=Brooks+Ghost+${i}`, { "x-real-ip": "198.51.100.99" }, "find.json"))).status;
    expect(last).toBe(429);
    const invalid = await GET(find(`q=Brooks&size=${"9".repeat(40)}`, { "x-real-ip": "198.51.100.98" }, "find.json"));
    expect(invalid.status).toBe(400);
  });
});

const outside: EventContext = {
  agent: { agent_class: "chatgpt-user", kind: "assistant", signature_agent: null, signature_verified: false },
  internal: false,
  caller_hash: "d".repeat(64),
  channel: "api",
};

describe("request pages built to be found", () => {
  it("has a summary title and Product + AggregateOffer JSON-LD from public prices only", async () => {
    const deps: Deps = { store, loadVariants: async () => fixture, context: outside };
    const posted = await postRequest(
      {
        text: "PRIVATEWORDS women's Brooks Ghost 16 size 8",
        brand: "Brooks",
        model: "Ghost 16",
        gender: "women",
        size: "8",
        max_price: 777.77,
        country: "US",
        holding: { seller: "SecretSellerCo", price: 4321.09, currency: "USD", delivery_by: inDays(5) },
      },
      deps,
    );
    await recordOffers(store, posted.id, [
      { store_domain: "example-road.test", source: "private_offer", via: "store_rule", price_cents: 11437, currency: "USD", available: true, product_url: "https://example-road.test/p", title: "Brooks Ghost 16", expires_at: null },
    ]);
    const page = await import("../app/r/[id]/page");
    const meta = await page.generateMetadata({ params: Promise.resolve({ id: posted.id }) });
    expect(JSON.stringify(meta.title)).toMatch(/Women Brooks Ghost 16 size 8: 2 stores answered, best public price \$119\.95, checked/);
    const html = renderToStaticMarkup(await page.default({ params: Promise.resolve({ id: posted.id }) }));
    expect(html).toContain("only the posting agent sees");
    const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]!;
    const data = JSON.parse(ld) as { "@type": string; offers: { "@type": string; lowPrice: string; offerCount: number } };
    expect(data["@type"]).toBe("Product");
    expect(data.offers).toMatchObject({ "@type": "AggregateOffer", lowPrice: "119.95", offerCount: 2 });
    expect(ld).not.toMatch(/114\.37|11437|PRIVATEWORDS|SecretSellerCo|4321|777|"US"|holding|max_price|vs_holding|hbp/);
    expect(JSON.stringify(meta)).not.toMatch(/114\.37|PRIVATEWORDS|SecretSellerCo|4321|777/);
  });
});

describe("store pages and the sitemap", () => {
  const real: CatalogVariant[] = fixture.map((variant) => ({ ...variant, store_domain: variant.store_domain.replace(".test", ".com") }));

  it("counts outside requests for a store, and a removed store has no page", async () => {
    const db = await openPglite();
    const deps: Deps = { store: db, loadVariants: async () => real, context: outside };
    await postRequest({ brand: "Brooks", model: "Ghost 16", gender: "women", size: "8", auction_seconds: 30 }, deps);
    await postRequest({ brand: "Brooks", model: "Ghost 16", gender: "women", size: "8" }, { ...deps, context: { ...outside, internal: true } });
    const later = Date.now() + 60_000;
    const data = (await storePageData(db, "example-run.com", real, later, new Set()))!;
    expect(data).toMatchObject({ requests_7d: 1, requests_30d: 1, best_public_30d: 1, compared_30d: 1 });
    expect(await storePageData(db, "example-run.com", real, later, new Set(["example-run.com"]))).toBeNull();
    expect(await storePageData(db, "never-seen.com", real, later, new Set())).toBeNull();
    expect(await storePageData(db, "not a domain", real, later, new Set())).toBeNull();
    await db.close();
  });

  it("lists only public pages: outside, visible requests and stores not removed", async () => {
    const db = await openPglite();
    const deps: Deps = { store: db, loadVariants: async () => real, context: outside };
    const shown = await postRequest({ brand: "Brooks", model: "Ghost 16" }, deps);
    const internal = await postRequest({ brand: "Brooks", model: "Ghost 16" }, { ...deps, context: { ...outside, internal: true } });
    const hidden = await postRequest({ brand: "Brooks", model: "Ghost 16" }, deps);
    await reportNeed(hidden.id, { reason: "", ipHash: "x", deleteToken: hidden.delete_token }, deps);
    const entries = await sitemapEntries(db, real, "https://haggleboard.com", Date.now(), new Set(["example-road.com"]));
    const urls = entries.map((entry) => entry.url);
    expect(urls).toContain(`https://haggleboard.com/r/${shown.id}`);
    expect(urls).not.toContain(`https://haggleboard.com/r/${internal.id}`);
    expect(urls).not.toContain(`https://haggleboard.com/r/${hidden.id}`);
    expect(urls).toContain("https://haggleboard.com/s/example-run.com");
    expect(urls).not.toContain("https://haggleboard.com/s/example-road.com");
    expect(urls).toContain("https://haggleboard.com/q/womens-asics-novablast-6-size-7");
    expect(urls.every((url) => /^https:\/\/haggleboard\.com\/(|board|q\/[a-z0-9-]+|r\/[0-9a-f-]{36}|s\/[a-z0-9.-]+)$/.test(url))).toBe(true);
    await db.close();
  });
});

describe("IndexNow and discovery", () => {
  it("is off by default and under tests, and its key file is 404 while off", async () => {
    expect(indexNowEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(indexNowEnabled({ INDEXNOW_ENABLED: "1", INDEXNOW_KEY: "abcdef0123456789", VITEST: "true" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    let called = false;
    const result = await submitIndexNow(["/r/x"], { INDEXNOW_ENABLED: "1", INDEXNOW_KEY: "abcdef0123456789", VITEST: "true" } as unknown as NodeJS.ProcessEnv, async () => {
      called = true;
      return new Response(null, { status: 200 });
    });
    expect(result.sent).toBe(false);
    expect(called).toBe(false);
    const { GET } = await import("../app/indexnow-key.txt/route");
    expect(GET().status).toBe(404);
  });

  it("serves /.well-known/haggleboard and says which messages are not implemented", async () => {
    const { GET } = await import("../app/.well-known/haggleboard/route");
    const body = (await GET().json()) as { messages: Record<string, { implemented: boolean | string }>; endpoints: Record<string, unknown> };
    expect(body.messages.counter!.implemented).toBe(false);
    expect(body.messages.accept!.implemented).toBe(false);
    expect(body.messages.request!.implemented).toBe("partly");
    expect(body.endpoints.mcp).toBe("https://haggleboard.com/api/mcp");
  });
});
