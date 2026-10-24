import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { crawlStore, stopsTheRun } from "../feeds/crawl";
import { BACKOFF_MS, HOST_INTERVAL_FLOOR_MS, resolveGlobalInterval, resolveHostInterval, SEVEN_DAY_BACKOFF_MS, USER_AGENT } from "../feeds/constants";
import { normalizeProduct } from "../feeds/normalize";
import { decidePath, parseRobots } from "../feeds/robots";
import type { StoreSeed } from "../feeds/seeds";

const seed: StoreSeed = { domain: "example.test", region: "US", country: "US", currency: "USD" };

describe("intervals", () => {
  it("refuses a faster crawl", () => {
    expect(resolveHostInterval(0)).toBe(HOST_INTERVAL_FLOOR_MS);
    expect(resolveHostInterval(1)).toBe(HOST_INTERVAL_FLOOR_MS);
    expect(resolveHostInterval(8000)).toBe(8000);
    expect(resolveGlobalInterval(0)).toBeGreaterThanOrEqual(2000);
    expect(resolveHostInterval(0, true)).toBe(0);
  });
});

describe("robots", () => {
  it("allows products.json unless a matching group disallows it", () => {
    expect(decidePath(parseRobots(""), "/products.json").allowed).toBe(true);
    expect(decidePath(parseRobots("User-agent: *\nDisallow: /admin\n"), "/products.json").allowed).toBe(true);
    expect(decidePath(parseRobots("User-agent: *\nDisallow: /\nAllow: /products\n"), "/products.json").allowed).toBe(
      true,
    );
    expect(decidePath(parseRobots("User-agent: *\nDisallow: /products.json\n"), "/products.json").allowed).toBe(false);
    const specific = parseRobots("User-agent: HaggleBoard-bot\nDisallow: /\n\nUser-agent: *\nAllow: /\n");
    expect(decidePath(specific, "/products.json").allowed).toBe(false);
    expect(decidePath(parseRobots("User-agent: *\nCrawl-delay: 8\nDisallow:\n"), "/products.json").crawlDelaySec).toBe(8);
  });
});

describe("normalize", () => {
  it("maps a Shopify product into variants", () => {
    const variants = normalizeProduct(
      {
        id: 99,
        title: "Brooks Women's Ghost 16 - Black",
        handle: "brooks-womens-ghost-16",
        vendor: "Brooks",
        product_type: "Running Shoes",
        tags: ["womens"],
        options: [
          { name: "Size", position: 1 },
          { name: "Color", position: 2 },
        ],
        variants: [
          {
            id: 5,
            title: "8 / Black",
            option1: "8",
            option2: "Black",
            price: "129.95",
            compare_at_price: "140.00",
            available: true,
          },
          {
            id: 6,
            option1: "M8 / W9.5",
            option2: "Blue",
            price: "129.95",
            compare_at_price: "0.00",
            available: false,
          },
        ],
      },
      {
        domain: "example.test",
        origin: "https://www.example.test",
        currency: "USD",
        country: "US",
        region: "US",
        observedAt: "2026-10-18T00:00:00.000Z",
      },
    );
    expect(variants).toHaveLength(2);
    expect(variants[0]).toMatchObject({
      brand: "Brooks",
      model: "Ghost 16",
      gender: "women",
      size: "8",
      color: "Black",
      price_cents: 12995,
      compare_at_cents: 14000,
      available: true,
      currency: "USD",
      product_url: "https://www.example.test/products/brooks-womens-ghost-16?variant=5",
    });
    expect(variants[1]?.size).toBe("9.5");
    expect(variants[1]?.size_men).toBe("8");
    expect(variants[1]?.compare_at_cents).toBeNull();
    expect(variants[1]?.available).toBe(false);
  });
});

describe("crawl", () => {
  it("waits between requests, honours robots, and stops on 429", async () => {
    const calls: string[] = [];
    let clock = 0;
    const blocked = await crawlStore({
      seed,
      pages: 2,
      limit: 1,
      cacheDir: mkdtempSync(path.join(tmpdir(), "hb-")),
      cacheTtlMs: 60_000,
      perHostMs: 40,
      globalMs: 10,
      allowFast: true,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      fetch: async (url, init) => {
        calls.push(String(url));
        expect(new Headers(init.headers).get("user-agent")).toBe(USER_AGENT);
        if (String(url).endsWith("/robots.txt")) {
          return new Response("User-agent: *\nDisallow: /products.json\n", { status: 200 });
        }
        throw new Error(`fetched ${url} after robots disallow`);
      },
    });
    expect(blocked.stopped).toBe(true);
    expect(blocked.stop_reason).toBe("robots");
    expect(calls).toHaveLength(1);

    calls.length = 0;
    clock = 0;
    const limited = await crawlStore({
      seed,
      pages: 2,
      limit: 1,
      cacheDir: mkdtempSync(path.join(tmpdir(), "hb-")),
      cacheTtlMs: 60_000,
      perHostMs: 40,
      globalMs: 10,
      allowFast: true,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      fetch: async (url) => {
        calls.push(String(url));
        if (String(url).endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow:\n", { status: 200 });
        if (String(url).includes("page=1")) return new Response("slow down", { status: 429, headers: { "retry-after": "30" } });
        throw new Error("page 2 was requested after 429");
      },
    });
    expect(limited.stop_reason).toBe("429");
    expect(limited.backoff_until).toBeTruthy();
    expect(calls.some((url) => url.includes("page=2"))).toBe(false);
  });

  it("spaces a second page and then serves it from cache", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hb-"));
    const product = {
      products: [
        {
          id: 1,
          title: "Brooks Ghost 16",
          handle: "brooks-ghost-16",
          vendor: "Brooks",
          product_type: "Running Shoes",
          tags: ["womens"],
          options: [{ name: "Size", position: 1 }],
          variants: [{ id: 7, option1: "8", price: "100.00", available: true }],
        },
      ],
    };
    let hits = 0;
    let clock = 0;
    const fetchImpl: typeof fetch = async (url) => {
      hits += 1;
      const target = String(url);
      if (target.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nCrawl-delay: 0\nDisallow:\n", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      if (target.includes("page=2")) {
        return new Response(JSON.stringify({ products: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(product), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const first = await crawlStore({
      seed,
      pages: 2,
      limit: 1,
      cacheDir: dir,
      cacheTtlMs: 60_000,
      perHostMs: 25,
      globalMs: 5,
      allowFast: true,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      fetch: fetchImpl,
    });
    const productWaits = first.requests.filter((item) => item.url.includes("/products.json") && !item.from_cache);
    expect(productWaits[0]?.waited_ms).toBeGreaterThanOrEqual(25);
    expect(first.variants).toHaveLength(1);
    expect(first.variants[0]?.product_url).toContain("variant=7");
    const after = hits;
    const second = await crawlStore({
      seed,
      pages: 2,
      limit: 1,
      cacheDir: dir,
      cacheTtlMs: 60_000,
      perHostMs: 25,
      globalMs: 5,
      allowFast: true,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      fetch: async () => {
        throw new Error("cache miss");
      },
    });
    expect(hits).toBe(after);
    expect(second.variants).toHaveLength(1);
    expect(second.requests.every((item) => item.from_cache)).toBe(true);
  });

  it("does not follow a redirect off the store", async () => {
    const calls: string[] = [];
    await crawlStore({
      seed,
      pages: 1,
      limit: 1,
      cacheDir: mkdtempSync(path.join(tmpdir(), "hb-")),
      cacheTtlMs: 1000,
      perHostMs: 1,
      globalMs: 1,
      allowFast: true,
      now: () => 0,
      sleep: async () => undefined,
      fetch: async (url) => {
        calls.push(String(url));
        if (String(url).endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow:\n", { status: 200 });
        return new Response(null, { status: 302, headers: { location: "https://evil.test/products.json" } });
      },
    });
    expect(calls.some((url) => url.includes("evil.test"))).toBe(false);
  });

  it("backs off on a robots 5xx or 403, and stops on a challenge", async () => {
    expect(stopsTheRun("429")).toBe(true);
    expect(stopsTheRun("challenge")).toBe(true);
    expect(stopsTheRun("forbidden")).toBe(false);

    const down = await crawlStore({
      seed,
      pages: 1,
      limit: 1,
      cacheDir: mkdtempSync(path.join(tmpdir(), "hb-")),
      cacheTtlMs: 1000,
      perHostMs: 1,
      globalMs: 1,
      allowFast: true,
      now: () => 0,
      sleep: async () => undefined,
      fetch: async () => new Response("unavailable", { status: 503 }),
    });
    expect(down.stop_reason).toBe("http-503");
    expect(Date.parse(down.backoff_until ?? "")).toBe(BACKOFF_MS);

    const forbidden = await crawlStore({
      seed,
      pages: 1,
      limit: 1,
      cacheDir: mkdtempSync(path.join(tmpdir(), "hb-")),
      cacheTtlMs: 1000,
      perHostMs: 1,
      globalMs: 1,
      allowFast: true,
      now: () => 0,
      sleep: async () => undefined,
      fetch: async () => new Response("no", { status: 403 }),
    });
    expect(forbidden.stop_reason).toBe("forbidden");
    expect(Date.parse(forbidden.backoff_until ?? "")).toBe(SEVEN_DAY_BACKOFF_MS);

    const calls: string[] = [];
    const challenged = await crawlStore({
      seed,
      pages: 2,
      limit: 1,
      cacheDir: mkdtempSync(path.join(tmpdir(), "hb-")),
      cacheTtlMs: 1000,
      perHostMs: 1,
      globalMs: 1,
      allowFast: true,
      now: () => 0,
      sleep: async () => undefined,
      fetch: async (url) => {
        calls.push(String(url));
        if (String(url).endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow:\n", { status: 200 });
        return new Response("<html>Just a moment</html>", {
          status: 200,
          headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
        });
      },
    });
    expect(challenged.stop_reason).toBe("challenge");
    expect(Date.parse(challenged.backoff_until ?? "")).toBe(SEVEN_DAY_BACKOFF_MS);
    expect(calls.some((url) => url.includes("page=2"))).toBe(false);
  });
});
