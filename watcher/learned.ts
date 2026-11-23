import type { Store } from "../lib/db.js";
import { asEvent } from "../lib/events.js";
import { brandKey } from "../referee/brands.js";

/**
 * A SMALL LEARNED INDEX from our own event log: which stores have answered for which brands before.
 * Every live read writes store.read with an outcome (found, not_found, out_of_stock, blocked, ...).
 * Joined with the brand of the request it was for, that says which stores carry a brand.
 *
 *  - a store with a past `found` for the brand is preferred;
 *  - a store with REPEATED_MISSES or more not_found reads for the brand, and no found, is not asked
 *    again for that brand (it saves the store a request and frees a slot under the 5-store cap).
 *
 * Out of stock counts as carrying the brand (the store lists it), and blocked or unreadable reads
 * say nothing about the brand, so neither counts as a miss.
 */
export const REPEATED_MISSES = 2;

export type ReadRow = { store_domain: string; brand: string | null; outcome: string; at?: string };
export type BrandStoreStats = { found: number; missed: number; last_found_at: string | null };
export type BrandIndex = Map<string, Map<string, BrandStoreStats>>;
export type Verdict = "hit" | "avoid" | "unknown";

/** Pure: build the index from store.read rows. */
export function learnBrandIndex(rows: ReadRow[]): BrandIndex {
  const index: BrandIndex = new Map();
  for (const row of rows) {
    if (!row.brand || !row.store_domain) continue;
    const brand = brandKey(row.brand);
    if (!brand) continue;
    const carried = row.outcome === "found" || row.outcome === "out_of_stock";
    const missed = row.outcome === "not_found";
    if (!carried && !missed) continue;
    const stores = index.get(brand) ?? new Map<string, BrandStoreStats>();
    const domain = row.store_domain.toLowerCase().replace(/^www\./, "");
    const stats = stores.get(domain) ?? { found: 0, missed: 0, last_found_at: null };
    if (carried) {
      stats.found += 1;
      if (row.at && (!stats.last_found_at || row.at > stats.last_found_at)) stats.last_found_at = row.at;
    } else stats.missed += 1;
    stores.set(domain, stats);
    index.set(brand, stores);
  }
  return index;
}

/**
 * A store that was asked about COLD_AFTER_MISSES or more products (any brand) and never had one is
 * "cold": a category store from ARC that does not sell what agents ask for here. It is not asked
 * again unless it is the brand's own store, a seed that lists the brand, or has a hit for the brand.
 */
export const COLD_AFTER_MISSES = 3;

/** Pure: per store across every brand, from store.read rows. */
export function learnStoreRecord(rows: ReadRow[]): Map<string, BrandStoreStats> {
  const out = new Map<string, BrandStoreStats>();
  for (const row of rows) {
    if (!row.store_domain) continue;
    const carried = row.outcome === "found" || row.outcome === "out_of_stock";
    const missed = row.outcome === "not_found";
    if (!carried && !missed) continue;
    const domain = row.store_domain.toLowerCase().replace(/^www\./, "");
    const stats = out.get(domain) ?? { found: 0, missed: 0, last_found_at: null };
    if (carried) stats.found += 1;
    else stats.missed += 1;
    out.set(domain, stats);
  }
  return out;
}

/** Pure: true when a store has COLD_AFTER_MISSES misses and no hit across all products. */
export function storeIsCold(record: Map<string, BrandStoreStats>, domain: string): boolean {
  const stats = record.get(domain.toLowerCase().replace(/^www\./, ""));
  return stats != null && stats.found === 0 && stats.missed >= COLD_AFTER_MISSES;
}

/** Pure: what the index says about asking `domain` for `brand`. */
export function brandVerdict(index: BrandIndex, brand: string | null, domain: string): Verdict {
  if (!brand) return "unknown";
  const stats = index.get(brandKey(brand))?.get(domain.toLowerCase().replace(/^www\./, ""));
  if (!stats) return "unknown";
  if (stats.found > 0) return "hit";
  if (stats.missed >= REPEATED_MISSES) return "avoid";
  return "unknown";
}

/** Pure: stores with a past hit for the brand, most hits first, then most recent. */
export function storesWithHits(index: BrandIndex, brand: string | null): string[] {
  if (!brand) return [];
  const stores = index.get(brandKey(brand));
  if (!stores) return [];
  return [...stores.entries()]
    .filter(([, stats]) => stats.found > 0)
    .sort((a, b) => b[1].found - a[1].found || String(b[1].last_found_at).localeCompare(String(a[1].last_found_at)) || a[0].localeCompare(b[0]))
    .map(([domain]) => domain);
}

/**
 * Reads the index for one brand from the event log. Internal reads count too: our own test posts
 * are real reads of real stores. Test-store events (TEST_STORES) are never store.read events.
 */
export async function loadBrandIndex(store: Store, brand: string | null, limit = 5_000): Promise<BrandIndex> {
  if (!brand) return new Map();
  const key = brandKey(brand);
  return learnBrandIndex((await loadReadRows(store, limit)).filter((row) => row.brand && brandKey(row.brand) === key));
}

/** Every store's record across all products, from the event log. */
export async function loadStoreRecord(store: Store, limit = 5_000): Promise<Map<string, BrandStoreStats>> {
  return learnStoreRecord(await loadReadRows(store, limit));
}

async function loadReadRows(store: Store, limit: number): Promise<ReadRow[]> {
  if (store.kind === "unavailable") return [];
  return (
    await store.select(
      `SELECT r.id, r.at, r.type, r.request_id, r.store_domain, r.agent_class, r.internal, r.public, r.private, p.public AS posted
       FROM events r JOIN events p ON p.request_id = r.request_id AND p.type = 'request.posted'
       WHERE r.type = 'store.read' ORDER BY r.at DESC LIMIT ?`,
      [limit],
    )
  ).map((row) => {
    const event = asEvent(row);
    let postedBrand: string | null = null;
    try {
      const posted = typeof row.posted === "string" ? (JSON.parse(row.posted) as { brand?: unknown }) : (row.posted as { brand?: unknown });
      postedBrand = typeof posted?.brand === "string" ? posted.brand : null;
    } catch {
      postedBrand = null;
    }
    const readBrand = typeof event.public.brand === "string" ? event.public.brand : postedBrand;
    return { store_domain: event.store_domain ?? "", brand: readBrand, outcome: String(event.public.outcome ?? ""), at: event.at };
  });
}
