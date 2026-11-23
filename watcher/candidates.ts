import type { AgentRoute } from "../feeds/agent-catalog.js";
import { loadSeeds, type StoreSeed } from "../feeds/seeds.js";
import { brandKey, findBrandInText } from "../referee/brands.js";
import type { CatalogVariant, ResolvedNeed } from "../referee/types.js";
import type { ArcClient, ArcPrecheck } from "./arc.js";
import { WATCH_MAX_STORES } from "./constants.js";
import type { Verdict } from "./learned.js";

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
  oofos: "oofos.com",
  birkenstock: "birkenstock.com",
};

export type Candidate = {
  domain: string;
  /** Where the watcher found this store: our own past reads, the brand's own store, ARC, or the seed list. */
  source: "learned" | "brand" | "arc" | "seed";
  /** The host to read. ARC's canonical host when it has one (www.example.com), else the domain. */
  fetch_host: string;
  currency: string | null;
  checkout_route_known: boolean | null;
  /** The store's own catalog search for agents, when ARC lists one that answered. Used instead of the feed. */
  agent_route: AgentRoute | null;
  /** True when this store is the brand's own official store. */
  official: boolean;
  /** What our own past reads say about this store and this brand. */
  learned: Verdict;
  fetchable: boolean;
  skip_reason: string | null;
};

const SHOE_WORDS = /\b(shoe|shoes|sneaker|sneakers|trainer|trainers|running|footwear|sandal|sandals|slide|slides|clog|clogs)\b/i;

/** ARC's find_stores takes a category or shopper words, not a product name (a product name is a bad_request). */
const ARC_CATEGORIES = ["apparel", "footwear", "beauty", "home", "food-drink", "supplements", "outdoor", "kids", "pets", "electronics", "jewelry"];

/**
 * The words sent to ARC's find_stores. Product fields only, never the poster's free text, which is
 * private. A category word when the need has one ARC knows, "running shoes" for shoe brands, else
 * nothing (ARC answers a product name with an error, so asking would waste a call).
 */
export function arcQuery(need: ResolvedNeed): string | null {
  const category = need.category?.trim().toLowerCase() ?? null;
  if (category && ARC_CATEGORIES.includes(category)) return category;
  if (category && SHOE_WORDS.test(category)) return "running shoes";
  if (looksLikeShoes(need)) return "running shoes";
  return category ? category.slice(0, 60) : null;
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
  /** What our own event log says about asking a store for this brand (watcher/learned.ts). */
  learned?: (domain: string) => Verdict;
  /** Stores with a past hit for this brand, best first. */
  learnedHits?: string[];
  /** True for a store our reads asked about several products and that never had one (watcher/learned.ts). */
  cold?: (domain: string) => boolean;
  /** Untried ARC category stores asked per request (default ARC_EXPLORE_PER_REQUEST). */
  arcExplore?: number;
};

/**
 * ARC's category stores are a guess: a footwear store may not sell running brands. At most this many
 * of them (with no past hit for the brand) are asked per request, so the rest of the 5 slots go to
 * the brand's own store, seeds that list the brand, and stores that had it before.
 */
export const ARC_EXPLORE_PER_REQUEST = 2;

/**
 * Candidate stores. Gathered from: stores our own reads found this brand at before, the brand's own
 * store, ARC (stores for the category, each with its saved agent routes), and seed stores whose
 * snapshot already lists the brand.
 *
 * Fetchable: a store whose public product feed the crawler can read (Shopify) or that publishes a
 * catalog search for agents (ARC lists it). Not asked: a store whose reads missed this brand
 * REPEATED_MISSES times with no hit.
 *
 * Order (at most WATCH_MAX_STORES are fetched): a past hit for the brand; the brand's own store; seed
 * stores whose snapshot lists the brand; ARC stores with an agent catalog search (a product-specific
 * question costs the store one request and answers exactly); ARC stores with a known checkout route;
 * other ARC stores.
 */
export async function chooseCandidates(need: ResolvedNeed, ctx: CandidateContext): Promise<Candidate[]> {
  const seeds = ctx.seeds ?? loadSeeds();
  const seedByDomain = new Map(seeds.map((seed) => [seed.domain, seed]));
  const ordered: Array<{ domain: string; source: Candidate["source"]; official: boolean }> = [];
  const push = (domain: string, source: Candidate["source"], official = false) => {
    const d = domain.toLowerCase().replace(/^www\./, "");
    const existing = ordered.find((item) => item.domain === d);
    if (existing) {
      existing.official ||= official;
      return;
    }
    ordered.push({ domain: d, source, official });
  };

  for (const domain of ctx.learnedHits ?? []) push(domain, "learned");

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

  const toCheck = ordered.filter((item) => !seedByDomain.has(item.domain)).map((item) => item.domain);
  const prechecks: Map<string, ArcPrecheck> = ctx.arc && toCheck.length > 0 ? await ctx.arc.precheck(toCheck) : new Map();
  const officialFor = need.brand ? BRAND_STORES[brandKey(need.brand)] : undefined;

  const candidates: Candidate[] = [];
  for (const item of ordered) {
    const pre = prechecks.get(item.domain) ?? null;
    const seed = seedByDomain.get(item.domain) ?? null;
    const route = pre?.agent_route ?? null;
    const learned = ctx.learned ? ctx.learned(item.domain) : "unknown";
    const official = item.official || officialFor === item.domain;
    let skip: string | null = null;
    if (ctx.removed.has(item.domain)) skip = "the store asked to be removed";
    else if (item.domain.endsWith(".example") || item.domain.endsWith(".test")) skip = "demo store";
    if (!skip) skip = await ctx.blocked(item.domain);
    if (!skip && learned === "avoid") skip = "our past reads did not find this brand here, twice or more";
    if (!skip && learned !== "hit" && !official && !seed && ctx.cold?.(item.domain)) {
      skip = "asked about several products before and never had one";
    }
    if (!skip && !seed && !route && item.source !== "learned") {
      if (pre?.known && !pre.shopify) skip = "no public product feed or agent catalog search known for this store";
      else if (!pre?.known && item.source === "brand" && !item.official) skip = "brand store not confirmed";
      else if (!pre?.known && item.source === "arc") skip = "no saved ARC record";
    }
    candidates.push({
      domain: item.domain,
      source: item.source,
      fetch_host: pre?.canonical_host ?? item.domain,
      currency: seed?.currency ?? pre?.currency ?? tldCurrency(item.domain),
      checkout_route_known: pre ? pre.reachable_checkout : null,
      agent_route: route,
      official,
      learned,
      fetchable: !skip,
      skip_reason: skip,
    });
  }

  const rank = (c: Candidate) => {
    if (c.learned === "hit") return 0;
    if (c.official) return 1;
    if (c.source === "seed") return 2;
    if (c.agent_route) return 3;
    if (c.checkout_route_known === true) return 4;
    return 5;
  };
  const sorted = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => rank(a.candidate) - rank(b.candidate) || a.index - b.index)
    .map((item) => item.candidate);

  let fetchable = 0;
  let explored = 0;
  for (const candidate of sorted) {
    if (!candidate.fetchable) continue;
    const exploring = candidate.source === "arc" && candidate.learned !== "hit" && !candidate.official;
    if (exploring && explored >= (ctx.arcExplore ?? ARC_EXPLORE_PER_REQUEST)) {
      candidate.fetchable = false;
      candidate.skip_reason = `over the ${ctx.arcExplore ?? ARC_EXPLORE_PER_REQUEST} untried category stores asked per request`;
      continue;
    }
    if (fetchable >= WATCH_MAX_STORES) {
      candidate.fetchable = false;
      candidate.skip_reason = `over the ${WATCH_MAX_STORES}-store limit for one request`;
      continue;
    }
    if (exploring) explored += 1;
    fetchable += 1;
  }
  return sorted;
}
