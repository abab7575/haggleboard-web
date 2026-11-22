import { loadSeeds, type StoreSeed } from "../feeds/seeds.js";
import { brandKey, findBrandInText } from "../referee/brands.js";
import type { CatalogVariant, ResolvedNeed } from "../referee/types.js";
import type { ArcClient, ArcPrecheck } from "./arc.js";
import { WATCH_MAX_STORES } from "./constants.js";

/** Official stores for brands we know. Anything else is a guess (<brand>.com) used only when ARC knows the domain. */
export const BRAND_STORES: Record<string, string> = {
  hoka: "hoka.com",
  brooks: "brooksrunning.com",
  nike: "nike.com",
  asics: "asics.com",
  "new balance": "newbalance.com",
  saucony: "saucony.com",
  on: "on.com",
  altra: "altrarunning.com",
  mizuno: "mizunousa.com",
  adidas: "adidas.com",
  salomon: "salomon.com",
  "topo athletic": "topoathletic.com",
  "under armour": "underarmour.com",
  reebok: "reebok.com",
  "inov 8": "inov-8.com",
  karhu: "karhu.com",
  skechers: "skechers.com",
  puma: "puma.com",
  "la sportiva": "lasportiva.com",
  norda: "nordarun.com",
  tracksmith: "tracksmith.com",
  merrell: "merrell.com",
  allbirds: "allbirds.com",
};

export type Candidate = {
  domain: string;
  /** Where the watcher found this store: the brand's own store, ARC, or the seed list. */
  source: "brand" | "arc" | "seed";
  /** The host to read. ARC's canonical host when it has one (www.example.com), else the domain. */
  fetch_host: string;
  currency: string | null;
  checkout_route_known: boolean | null;
  fetchable: boolean;
  skip_reason: string | null;
};

const SHOE_WORDS = /\b(shoe|shoes|sneaker|sneakers|trainer|trainers|running|footwear)\b/i;

/**
 * The words sent to ARC. Product fields only: brand, model, category. Never the poster's free text,
 * which is private.
 */
export function arcQuery(need: ResolvedNeed): string | null {
  const words = need.category ?? [need.brand, need.model].filter(Boolean).join(" ");
  return words.trim() ? words.trim().slice(0, 120) : null;
}

export function tldCurrency(domain: string): string | null {
  if (/\.co\.uk$|\.uk$/.test(domain)) return "GBP";
  if (/\.ie$|\.de$|\.fr$|\.nl$|\.es$|\.it$|\.be$|\.at$|\.fi$|\.pt$/.test(domain)) return "EUR";
  if (/\.ca$/.test(domain)) return "CAD";
  if (/\.com\.au$|\.au$/.test(domain)) return "AUD";
  if (/\.sg$/.test(domain)) return "SGD";
  return null;
}

function looksLikeShoes(need: ResolvedNeed): boolean {
  if (need.category && SHOE_WORDS.test(need.category)) return true;
  if (need.brand && findBrandInText(need.brand)) return true;
  return false;
}

export type CandidateContext = {
  arc: ArcClient | null;
  removed: Set<string>;
  blocked: (domain: string) => Promise<string | null>;
  variants: CatalogVariant[];
  seeds?: StoreSeed[];
};

/**
 * Candidate stores, in this order: (a) the brand's own store when a brand is named, (b) stores from
 * ARC for the product's category or name, preferring stores where ARC has a known checkout route,
 * (c) seed stores whose snapshot already lists the brand. Only stores whose public product feed the
 * crawler can read (Shopify) are fetchable. At most WATCH_MAX_STORES are marked fetchable.
 */
export async function chooseCandidates(need: ResolvedNeed, ctx: CandidateContext): Promise<Candidate[]> {
  const seeds = ctx.seeds ?? loadSeeds();
  const seedByDomain = new Map(seeds.map((seed) => [seed.domain, seed]));
  const ordered: Array<{ domain: string; source: Candidate["source"]; official: boolean }> = [];
  const push = (domain: string, source: Candidate["source"], official = false) => {
    const d = domain.toLowerCase().replace(/^www\./, "");
    if (!ordered.some((item) => item.domain === d)) ordered.push({ domain: d, source, official });
  };

  if (need.brand) {
    const key = brandKey(need.brand);
    const known = BRAND_STORES[key];
    if (known) push(known, "brand", true);
    else if (/^[a-z0-9]+$/.test(key.replace(/\s+/g, ""))) push(`${key.replace(/\s+/g, "")}.com`, "brand", false);
  }

  const query = arcQuery(need);
  const arcStores = ctx.arc && query ? await ctx.arc.findStores(query) : [];
  for (const store of arcStores) push(store.host, "arc");

  if (need.brand && looksLikeShoes(need)) {
    const key = brandKey(need.brand);
    const carrying = new Set(
      ctx.variants.filter((variant) => brandKey(variant.brand) === key).map((variant) => variant.store_domain),
    );
    for (const seed of seeds) if (carrying.has(seed.domain)) push(seed.domain, "seed");
  }

  const nonSeed = ordered.filter((item) => item.source !== "seed").map((item) => item.domain);
  const prechecks: Map<string, ArcPrecheck> = ctx.arc && nonSeed.length > 0 ? await ctx.arc.precheck(nonSeed) : new Map();

  const candidates: Candidate[] = [];
  for (const item of ordered) {
    const pre = prechecks.get(item.domain) ?? null;
    const seed = seedByDomain.get(item.domain) ?? null;
    let skip: string | null = null;
    if (ctx.removed.has(item.domain)) skip = "the store asked to be removed";
    else if (item.domain.endsWith(".example") || item.domain.endsWith(".test")) skip = "demo store";
    if (!skip) skip = await ctx.blocked(item.domain);
    if (!skip && !seed) {
      if (pre?.known && !pre.shopify) skip = "no public product feed known for this store";
      else if (!pre?.known && item.source === "brand" && !item.official) skip = "brand store not confirmed";
      else if (!pre?.known && item.source === "arc") skip = "no saved ARC record";
    }
    candidates.push({
      domain: item.domain,
      source: item.source,
      fetch_host: pre?.canonical_host ?? item.domain,
      currency: seed?.currency ?? pre?.currency ?? tldCurrency(item.domain),
      checkout_route_known: pre ? pre.reachable_checkout : null,
      fetchable: !skip,
      skip_reason: skip,
    });
  }

  // Brand store first, then ARC stores with a known checkout route, then other ARC stores, then seeds.
  const rank = (c: Candidate) =>
    c.source === "brand" ? 0 : c.source === "arc" ? (c.checkout_route_known === true ? 1 : 2) : 3;
  const sorted = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => rank(a.candidate) - rank(b.candidate) || a.index - b.index)
    .map((item) => item.candidate);

  let fetchable = 0;
  for (const candidate of sorted) {
    if (!candidate.fetchable) continue;
    if (fetchable >= WATCH_MAX_STORES) {
      candidate.fetchable = false;
      candidate.skip_reason = `over the ${WATCH_MAX_STORES}-store limit for one request`;
      continue;
    }
    fetchable += 1;
  }
  return sorted;
}
