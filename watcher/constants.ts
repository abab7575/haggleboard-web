/**
 * Hard limits for the watcher. A single request can never make more store fetches than this.
 * The crawler's own rules (robots.txt, the bot user agent, minimum gaps, back-offs, the removal
 * list) apply to every fetch on top of these limits.
 */

/** At most this many stores are looked up for one request. */
export const WATCH_MAX_STORES = 5;

/** One product-feed request per store (Shopify /products.json, page 1). */
export const WATCH_FEED_REQUESTS_PER_STORE = 1;

/**
 * robots.txt is read before the feed, as the crawler always does, and is cached for 12 hours.
 * It is the only other request a store can see from one watch run.
 */
export const WATCH_ROBOTS_REQUESTS_PER_STORE = 1;

/** The fixed ceiling on network fetches to stores for one request: 5 stores x (1 feed + 1 robots). */
export const WATCH_MAX_STORE_FETCHES =
  WATCH_MAX_STORES * (WATCH_FEED_REQUESTS_PER_STORE + WATCH_ROBOTS_REQUESTS_PER_STORE);

/** Products per feed page. The crawler's own ceiling (MAX_LIMIT) is 250. */
export const WATCH_FEED_LIMIT = 250;

/** ARC: at most this many calls for one request (find_stores and one bulk precheck). */
export const ARC_MAX_CALLS_PER_REQUEST = 2;
export const ARC_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
export const ARC_TIMEOUT_MS = 10_000;
export const ARC_FIND_LIMIT = 10;
export const ARC_ASK_URL = "https://www.arcreport.ai/api/ask";
export const ARC_PRECHECK_BULK_URL = "https://www.arcreport.ai/api/precheck/bulk";

/** Requests older than this are not picked up by the worker. */
export const WATCH_PICKUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A private offer made under a store rule lasts this long unless the rule says less. */
export const DEFAULT_OFFER_TTL_MINUTES = 60;
export const MAX_OFFER_TTL_MINUTES = 24 * 60;

function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/** Run the watcher right after a request is posted (inside the request, via next/server after()). Off by default. */
export function watcherInline(env: NodeJS.ProcessEnv = process.env): boolean {
  return flag(env, "WATCHER_INLINE");
}

/** ARC lookups are on unless WATCHER_USE_ARC is 0, false or no. */
export function arcEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.WATCHER_USE_ARC?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "no");
}

/** Claimed stores' standing rules and the private offers made from them. Off by default. */
export function storeRulesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flag(env, "STORE_RULES_ENABLED");
}

/** Queue one notification per unclaimed store. Off by default. There is no sending code. */
export function notifyStoresEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flag(env, "NOTIFY_STORES_ENABLED");
}
