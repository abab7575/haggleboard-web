import { USER_AGENT } from "./constants.js";
import type { StoreCrawlResult } from "./crawl.js";

export function buildFixture(results: StoreCrawlResult[], crawledAt: string) {
  return {
    generated_by: "HaggleBoard" as const,
    user_agent: USER_AGENT,
    crawled_at: crawledAt,
    synthetic: false,
    note: "Titles, prices, product URLs, and observed dates from public Shopify /products.json responses. No descriptions and no images. HaggleBoard is not affiliated with these stores. Checkout is on the store's own website.",
    stores: results.map((result) => ({
      domain: result.domain,
      country: result.country,
      region: result.region,
      currency: result.currency,
      shop_origin: result.shop_origin,
      pages_fetched: result.pages_fetched,
      robots_allowed: result.robots_allowed,
      stopped: result.stopped,
      stop_reason: result.stop_reason,
      variant_count: result.variants.length,
      requests: result.requests,
    })),
    variants: results.flatMap((result) => result.variants),
  };
}
