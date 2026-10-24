import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openPglite } from "../lib/db";
import { readFixture } from "../lib/catalog";
import { getOffers, isDemoSeller, postRequest, searchProducts, type Deps } from "../lib/service";

describe("live results exclude demo sellers", () => {
  it("flags .example and demo:true sellers", () => {
    expect(isDemoSeller({ store_domain: "harbourhotel.example" })).toBe(true);
    expect(isDemoSeller({ store_domain: "Shoes.EXAMPLE." })).toBe(true);
    expect(isDemoSeller({ store_domain: "example-run.test", demo: true })).toBe(true);
    expect(isDemoSeller({ store_domain: "example-run.test" })).toBe(false);
    expect(isDemoSeller({ store_domain: "notexample.com" })).toBe(false);
  });

  it("never returns demo offers from post_request, get_offers or search_products", async () => {
    process.env.DELETE_TOKEN_KEY ??= "test-delete-token-key-0123456789abcdef";
    const store = await openPglite();
    const real = readFixture(path.join(process.cwd(), "fixtures", "mini-catalog.json")).variants;
    const demo = real.map((v) => ({ ...v, store_domain: "demo-runner.example", product_url: v.product_url.replace("example-run.test", "demo-runner.example") }));
    const deps: Deps = { store, loadVariants: async () => [...demo, ...real] };
    const posted = await postRequest({ text: "women's Brooks Ghost 16, size 8, under $130" }, deps);
    const again = await getOffers({ request_id: posted.id }, deps);
    const search = await searchProducts({ query: "Brooks Ghost" }, deps);
    const all = JSON.stringify([posted, again, search]);
    expect(posted.offers.length).toBeGreaterThan(0);
    expect(all).not.toMatch(/\.example/);
    await store.close();
  });

  it("homepage no longer prints the snapshot source or 'Buy at the store'", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "app", "page.tsx"), "utf8");
    expect(src).not.toMatch(/Source: \$\{/);
    expect(src).not.toMatch(/Buy at the store/i);
  });
});
