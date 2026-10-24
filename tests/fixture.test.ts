import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readFixture } from "../lib/catalog";
import { openSqlite } from "../lib/db";
import { getOffers, type Deps } from "../lib/service";
import { handleMcpRequest } from "../mcp/http";
import { USER_AGENT } from "../lib/copy";
import { HOST_INTERVAL_FLOOR_MS } from "../feeds/constants";

const file = path.join(process.cwd(), "fixtures", "sample-crawl.json");

describe("sample crawl fixture", () => {
  it("comes from a polite crawl of 2 or 3 stores", () => {
    expect(existsSync(file), "missing fixtures/sample-crawl.json").toBe(true);
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toMatch(/@/);
    const fixture = readFixture(file);
    expect(fixture.synthetic).not.toBe(true);
    expect(fixture.user_agent).toBe("HaggleBoard-bot (+https://haggleboard.com)");
    expect(USER_AGENT).toContain("contact@haggleboard.com");
    expect(fixture.generated_by).toBe("HaggleBoard");
    const stores = (fixture.stores ?? []) as Array<{
      domain: string;
      pages_fetched: number;
      variant_count: number;
      requests: Array<{ url: string; status: number | null; waited_ms: number; from_cache: boolean }>;
    }>;
    const useful = stores.filter((store) => store.pages_fetched > 0 && store.variant_count > 0);
    expect(useful.length).toBeGreaterThanOrEqual(2);
    expect(useful.length).toBeLessThanOrEqual(3);
    for (const store of useful) {
      expect(store.pages_fetched).toBeLessThanOrEqual(2);
      const live = store.requests.filter((request) => !request.from_cache);
      expect(live.length).toBeGreaterThan(0);
      expect(live.length).toBeLessThanOrEqual(8);
      for (let i = 1; i < live.length; i++) {
        expect(live[i]?.waited_ms).toBeGreaterThanOrEqual(HOST_INTERVAL_FLOOR_MS);
      }
      expect(live.some((request) => request.url.includes("/products.json") && request.status === 200)).toBe(true);
    }
    expect(fixture.variants.length).toBeGreaterThan(0);
    const sample = fixture.variants[0]!;
    expect(sample.product_url).toMatch(/^https:\/\//);
    expect(sample.currency).toMatch(/^[A-Z]{3}$/);
    expect(typeof sample.price_cents).toBe("number");
  });

  it("answers get_offers from the crawled listings", async () => {
    const fixture = readFixture(file);
    const shoe = fixture.variants.find((variant) => variant.category === "shoe" && variant.available && variant.brand && variant.size);
    expect(shoe).toBeTruthy();
    const store = await openSqlite(":memory:");
    const deps: Deps = { store, loadVariants: async () => fixture.variants };
    const result = await getOffers({ brand: shoe!.brand, model: shoe!.model, size: shoe!.size, gender: shoe!.gender === "unknown" ? undefined : shoe!.gender }, deps);
    expect(result.offers.some((offer) => offer.product_url === shoe!.product_url)).toBe(true);
    expect(result.offers.every((offer) => offer.checkout === "store_site")).toBe(true);

    const response = await handleMcpRequest(
      new Request("http://haggleboard.test/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "get_offers",
            arguments: { brand: shoe!.brand, model: shoe!.model, size: shoe!.size },
          },
        }),
      }),
      deps,
    );
    const body = await response.json();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.offers.some((offer: { product_url: string }) => offer.product_url === shoe!.product_url)).toBe(true);
    await store.close();
  });
});
