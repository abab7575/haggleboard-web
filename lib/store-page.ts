import { bestPublic, currentOffers, offersFromEvents, windowFromEvents } from "./auction.js";
import type { Store } from "./db.js";
import { requestEvents } from "./events.js";
import { loadRemoved } from "../feeds/seeds.js";
import type { CatalogVariant } from "../referee/types.js";

const DAY = 86_400_000;
const DOMAIN = /^(?=.{4,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function normalizeDomain(raw: string): string | null {
  const domain = decodeURIComponent(raw).trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return DOMAIN.test(domain) && !domain.endsWith(".example") && !domain.endsWith(".test") ? domain : null;
}

export type StorePageData = {
  domain: string;
  as_of: string;
  requests_7d: number;
  requests_30d: number;
  best_public_30d: number;
  compared_30d: number;
  in_snapshot: boolean;
};

/**
 * Numbers for /s/{domain}, from the event log, outside traffic only. "Requests for products this
 * store carries" means outside requests where this store had an offer: its public price matched
 * (snapshot or watcher) or it made an offer. "Best public price" counts those requests whose
 * window has closed where this store had the lowest in-stock public price in the main currency.
 * Null when the store is on the removal list or we have never seen it.
 */
export async function storePageData(
  store: Store,
  rawDomain: string,
  variants: CatalogVariant[],
  now = Date.now(),
  removed: Set<string> = loadRemoved(),
): Promise<StorePageData | null> {
  const domain = normalizeDomain(rawDomain);
  if (!domain || removed.has(domain)) return null;
  const inSnapshot = variants.some((variant) => variant.store_domain === domain);
  const since30 = new Date(now - 30 * DAY).toISOString();
  const since7 = new Date(now - 7 * DAY).toISOString();
  const rows =
    store.kind === "unavailable"
      ? []
      : await store.select(
          `SELECT request_id, MIN(at) AS at FROM events
           WHERE type = 'offer.made' AND store_domain = ? AND internal = 0 AND at >= ? AND request_id IS NOT NULL
           GROUP BY request_id ORDER BY MIN(at) DESC LIMIT 500`,
          [domain, since30],
        );
  if (!inSnapshot && rows.length === 0) {
    const seen = store.kind === "unavailable" ? [] : await store.select("SELECT 1 AS n FROM events WHERE store_domain = ? AND internal = 0 LIMIT 1", [domain]);
    if (seen.length === 0) return null;
  }
  let best = 0;
  let compared = 0;
  for (const row of rows.slice(0, 200)) {
    const events = await requestEvents(store, String(row.request_id));
    const window = windowFromEvents(events);
    if (!window || window.deadline > new Date(now).toISOString()) continue;
    const ranked = currentOffers(offersFromEvents(events, window.deadline));
    const main = ranked[0]?.currency;
    if (!main) continue;
    const top = bestPublic(ranked, main);
    if (!top) continue;
    compared += 1;
    if (top.store_domain === domain) best += 1;
  }
  return {
    domain,
    as_of: new Date(now).toISOString(),
    requests_7d: rows.filter((row) => String(row.at) >= since7).length,
    requests_30d: rows.length,
    best_public_30d: best,
    compared_30d: compared,
    in_snapshot: inSnapshot,
  };
}

/** Stores worth a page: seen with outside offers in the last 30 days, or in the snapshot; never removed ones. */
export async function storesWithPages(store: Store, variants: CatalogVariant[], now = Date.now(), removed: Set<string> = loadRemoved()): Promise<string[]> {
  const since = new Date(now - 30 * DAY).toISOString();
  const rows =
    store.kind === "unavailable"
      ? []
      : await store.select(
          "SELECT DISTINCT store_domain FROM events WHERE type = 'offer.made' AND internal = 0 AND at >= ? AND store_domain IS NOT NULL",
          [since],
        );
  const all = new Set<string>([...variants.map((variant) => variant.store_domain), ...rows.map((row) => String(row.store_domain))]);
  return [...all]
    .map((domain) => normalizeDomain(domain))
    .filter((domain): domain is string => domain != null && !removed.has(domain))
    .sort();
}
