import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hostMatchesDomain } from "../feeds/host.js";
import { loadRemoved } from "../feeds/seeds.js";
import { DISCLAIMER } from "./copy.js";
import { getStore, StoreUnavailableError, variantToRow, type BidRow, type RequestOrigin, type Store } from "./db.js";
import { defaultFixturePath, readFixture } from "./catalog.js";
import { HttpError } from "./http.js";
import { bidsEnabled, deleteTokenHmac, deleteTokenKey, hmacEqual, newDeleteToken, newStoreKey, storeKeyHmac } from "./keys.js";
import { centsToDecimal, toCents } from "../referee/money.js";
import { canonicalSize } from "../referee/attributes.js";
import { matchVariants, variantMatches } from "../referee/match.js";
import { needIsEmpty, normalizeGtin, normalizeStoredNeed, parseNeed } from "../referee/parse.js";
import { rankOffers } from "../referee/rank.js";
import type { CatalogVariant, Gender, PublicNeed, PublicOffer, ResolvedNeed } from "../referee/types.js";
import { compareWithHolding, productOnly, publicNeed, publicOffer } from "./privacy.js";
import { defaultOrigin } from "./origin.js";
import { getWatchRun, listWatchOffers, type WatchRun } from "./watch-store.js";
import { listPrivateOffers, type PrivateOffer } from "../watcher/store-rules.js";
import { productMatches } from "../referee/match.js";

export type Deps = {
  loadVariants: () => Promise<CatalogVariant[]>;
  store: Store;
  /** Where the current request came from (lib/origin.ts). Defaults to "test" under tests, else "internal". */
  origin?: RequestOrigin;
  /** Called after a request is stored. The app routes use it to run the watcher when WATCHER_INLINE is on. */
  afterPost?: (request: { id: string; need: ResolvedNeed; origin: RequestOrigin }) => void;
};

const DAY_MS_LOCAL = 24 * 60 * 60 * 1000;

function isCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** An order the shopper already holds elsewhere. PRIVATE. `price` is the total for the quantity asked for. */
export const holdingSchema = z
  .object({
    seller: z.string().trim().min(1).max(120).optional(),
    price: z.number().positive().max(1_000_000),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/, "holding.currency must be a 3-letter code such as USD"),
    delivered: z.boolean().optional(),
    delivery_by: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "holding.delivery_by must be a date such as 2026-12-01")
      .refine(isCalendarDate, "holding.delivery_by is not a real date")
      .refine(
        (value) => Date.parse(`${value}T00:00:00.000Z`) >= Date.now() - 2 * DAY_MS_LOCAL,
        "holding.delivery_by is in the past",
      )
      .refine(
        (value) => Date.parse(`${value}T00:00:00.000Z`) <= Date.now() + 400 * DAY_MS_LOCAL,
        "holding.delivery_by is more than a year away",
      )
      .optional(),
  })
  .strict();

const needSchema = z.object({
  text: z.string().trim().max(500).optional(),
  brand: z.string().trim().max(80).optional(),
  model: z.string().trim().max(120).optional(),
  gtin: z
    .string()
    .trim()
    .refine((value) => normalizeGtin(value) != null, "gtin must be an 8, 12, 13 or 14 digit barcode with a valid check digit")
    .optional(),
  gender: z.enum(["women", "men", "unisex", "kids"]).optional(),
  size: z.string().trim().max(32).optional(),
  color: z.string().trim().max(60).optional(),
  attributes: z
    .record(z.string().trim().min(1).max(40), z.string().trim().max(80))
    .refine((value) => Object.keys(value).length <= 10, "attributes can have at most 10 entries")
    .optional(),
  quantity: z.number().int().min(1).max(1000).optional(),
  category: z.string().trim().max(80).optional(),
  max_price: z.number().positive().max(100_000).optional(),
  currency: z.string().trim().length(3).optional(),
  region: z.string().trim().max(40).optional(),
  country: z.string().trim().max(40).optional(),
  holding: holdingSchema.optional(),
  limit: z.number().int().min(1).max(50).optional(),
  request_id: z.string().uuid().optional(),
  delete_token: z.string().trim().min(16).max(200).optional(),
});

const bidSchema = z.object({
  store_domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/),
  product_url: z.string().trim().url(),
  price: z.number().positive().max(100_000),
  currency: z
    .string()
    .trim()
    .length(3)
    .transform((value) => value.toUpperCase()),
  request_id: z.string().uuid().optional(),
  brand: z.string().trim().max(80).optional(),
  model: z.string().trim().max(120).optional(),
  title: z.string().trim().max(200).optional(),
  gender: z.enum(["women", "men", "unisex", "kids"]).optional(),
  size: z.string().trim().max(32).optional(),
  color: z.string().trim().max(80).optional(),
  available: z.boolean().optional(),
  compare_at_price: z.number().positive().max(100_000).optional(),
  shipping: z.string().trim().max(160).optional(),
  delivery_days: z.number().int().min(0).max(60).optional(),
  returns_days: z.number().int().min(0).max(365).optional(),
  note: z.string().trim().max(500).optional(),
});

export type StoredBid = z.infer<typeof bidSchema> & { id: string; verified?: boolean };

export async function defaultDeps(): Promise<Deps> {
  const store = await getStore();
  return {
    store,
    loadVariants: async () => {
      const removed = loadRemoved();
      const count = await store.countVariants();
      const variants = count > 0 ? await store.listVariants() : readFixture(defaultFixturePath()).variants;
      return variants.filter((variant) => !removed.has(variant.store_domain));
    },
  };
}

/** Demo/sandbox sellers (.example domains, or flagged demo) never appear in live results. */
export function isDemoSeller(v: { store_domain?: string; demo?: unknown }): boolean {
  const d = (v.store_domain ?? "").toLowerCase().replace(/\.$/, "");
  return v.demo === true || d === "example" || d.endsWith(".example");
}

async function liveVariants(deps: Deps) {
  return (await deps.loadVariants()).filter((v) => !isDemoSeller(v as { store_domain?: string; demo?: unknown }));
}

export const PRIVACY_NOTE =
  "Only you see your text, your maximum price and the order you hold. The public board shows the product, when it was posted, how many stores answered, and their public prices.";

export async function postRequest(input: unknown, deps: Deps) {
  const body = parseNeedBody(input);
  const need = parseNeed(body);
  assertPostable(need);
  const id = randomUUID();
  const created_at = new Date().toISOString();
  const delete_token = newDeleteToken();
  let persisted = false;
  const origin = deps.origin ?? defaultOrigin();
  if (deps.store.kind !== "unavailable") {
    try {
      await deps.store.saveRequest({
        id,
        need_json: JSON.stringify(need),
        created_at,
        delete_token_hmac: deleteTokenHmac(deleteTokenKey(), id, delete_token),
        origin,
      });
      persisted = true;
    } catch (error) {
      if (!(error instanceof StoreUnavailableError)) throw error;
    }
  }
  if (persisted) deps.afterPost?.({ id, need, origin });
  const result = await collectOffers(need, persisted ? id : null, deps, body.limit ?? 20, "poster");
  return {
    id,
    persisted,
    created_at,
    delete_token: persisted ? delete_token : null,
    board_url: persisted ? `/r/${id}` : null,
    need,
    offers: result.offers,
    omitted_unavailable: result.omitted_unavailable,
    hint: needHint(need, result.offers.length),
    privacy: PRIVACY_NOTE,
    checkout: "store_site" as const,
    disclaimer: DISCLAIMER,
  };
}

function needHint(need: ResolvedNeed, offers: number): string | null {
  if (!need.brand && !need.model && !need.gtin) {
    return "Add a brand and model, or a barcode (gtin), so stores can match it.";
  }
  if (offers === 0) {
    return "No public listing matched yet. The request is on the board. Call get_offers with request_id and delete_token later.";
  }
  return null;
}

/**
 * With request_id and the matching delete_token: the poster's private view.
 * With request_id alone: the public view (product, public prices; nothing private).
 * Without request_id: a one-off query, answered to the asker and not stored.
 */
export async function getOffers(input: unknown, deps: Deps) {
  const body = parseNeedBody(input ?? {});
  if (body.request_id) {
    const row = await deps.store.getRequest(body.request_id);
    if (!row) throw new HttpError(404, "No stored request with that id");
    const stored = normalizeStoredNeed(JSON.parse(row.need_json) as Partial<ResolvedNeed>);
    const poster = body.delete_token ? posterTokenMatches(row, body.delete_token) : false;
    const view: View = poster ? "poster" : "public";
    const result = await collectOffers(stored, body.request_id, deps, body.limit ?? 20, view);
    return {
      request_id: body.request_id,
      view,
      created_at: row.created_at,
      need: result.need,
      offers: result.offers,
      omitted_unavailable: result.omitted_unavailable,
      watch: watchView(await getWatchRun(deps.store, body.request_id)),
      checkout: "store_site" as const,
      disclaimer: DISCLAIMER,
    };
  }
  const need = parseNeed(body);
  assertSearchable(need);
  const result = await collectOffers(need, null, deps, body.limit ?? 20, "poster");
  return {
    request_id: null,
    view: "query" as const,
    created_at: null,
    need: result.need,
    offers: result.offers,
    omitted_unavailable: result.omitted_unavailable,
    checkout: "store_site" as const,
    disclaimer: DISCLAIMER,
  };
}

function posterTokenMatches(row: { id: string; delete_token_hmac: string | null }, token: string): boolean {
  if (!row.delete_token_hmac) return false;
  let key: string;
  try {
    key = deleteTokenKey();
  } catch {
    return false;
  }
  return hmacEqual(row.delete_token_hmac, deleteTokenHmac(key, row.id, token));
}

export async function searchProducts(input: unknown, deps: Deps) {
  const parsed = z
    .object({
      query: z.string().trim().min(1).max(200).optional(),
      text: z.string().trim().min(1).max(200).optional(),
      brand: z.string().trim().max(80).optional(),
      model: z.string().trim().max(120).optional(),
      gender: z.enum(["women", "men", "unisex", "kids"]).optional(),
      size: z.string().trim().max(32).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .safeParse(input ?? {});
  if (!parsed.success) throw new HttpError(400, "The product search is not valid");
  const need = parseNeed({
    text: parsed.data.query ?? parsed.data.text,
    brand: parsed.data.brand,
    model: parsed.data.model,
    gender: parsed.data.gender,
    size: parsed.data.size,
  });
  assertSearchable(need);
  const matches = matchVariants(await liveVariants(deps), need, true);
  const groups = new Map<string, CatalogVariant[]>();
  for (const variant of matches) {
    const key = `${variant.store_domain}:${variant.handle}`;
    const list = groups.get(key) ?? [];
    list.push(variant);
    groups.set(key, list);
  }
  const products = [...groups.values()]
    .map((list) => {
      const cheapest = [...list].sort((a, b) => a.price_cents - b.price_cents)[0]!;
      const sizes = [...new Set(list.map((item) => item.size).filter((size): size is string => Boolean(size)))].sort(
        (a, b) => Number(a) - Number(b) || a.localeCompare(b),
      );
      return {
        store_domain: cheapest.store_domain,
        brand: cheapest.brand,
        model: cheapest.model,
        title: cheapest.title,
        gender: cheapest.gender,
        currency: cheapest.currency,
        min_price: cheapest.price,
        min_price_cents: cheapest.price_cents,
        product_url: cheapest.product_url,
        sizes,
        checkout: "store_site" as const,
      };
    })
    .sort((a, b) => a.min_price_cents - b.min_price_cents || a.store_domain.localeCompare(b.store_domain));
  return {
    products: products.slice(0, parsed.data.limit ?? 20),
    disclaimer: DISCLAIMER,
  };
}

export async function submitBid(input: unknown, key: string | null, deps: Deps, env: NodeJS.ProcessEnv = process.env) {
  if (!bidsEnabled(env)) {
    throw new HttpError(503, "Store bids are off until each store has its own key.");
  }
  const signing = env.BID_TOKEN_SIGNING_KEY?.trim();
  if (!signing) throw new HttpError(503, "Store bids need BID_TOKEN_SIGNING_KEY.");
  const parsed = bidSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "The offer is not valid");
  if (!key || key.length < 32 || key.length > 200 || /\s/.test(key)) {
    throw new HttpError(401, "Send the store key in X-HaggleBoard-Store-Key.");
  }
  if (deps.store.kind === "unavailable") {
    throw new HttpError(503, "Bids need DATABASE_URL. The offer shape was valid, and nothing was stored.");
  }
  assertCheckoutUrl(parsed.data.store_domain, parsed.data.product_url);
  const actual = storeKeyHmac(signing, parsed.data.store_domain, key);
  const expected = (await deps.store.getStoreKey(parsed.data.store_domain)) ?? "0".repeat(actual.length);
  if (!hmacEqual(expected, actual)) {
    throw new HttpError(401, "That store key does not match the key issued for this store.");
  }
  if (parsed.data.request_id) {
    const request = await deps.store.getRequest(parsed.data.request_id);
    if (!request) throw new HttpError(404, "No stored request with that id");
  }
  const id = randomUUID();
  const created_at = new Date().toISOString();
  const stored: StoredBid = { ...parsed.data, id, verified: true };
  try {
    await deps.store.saveBid({
      id,
      request_id: parsed.data.request_id ?? null,
      store_domain: parsed.data.store_domain,
      key_hash: actual,
      bid_json: JSON.stringify(stored),
      created_at,
    });
  } catch (error) {
    if (error instanceof StoreUnavailableError) {
      throw new HttpError(503, "Bids need DATABASE_URL. The offer shape was valid, and nothing was stored.");
    }
    throw error;
  }
  return {
    id,
    auth: "verified" as const,
    offer: bidToOffer(stored, created_at),
    disclaimer: DISCLAIMER,
  };
}

export async function issueStoreKey(domain: string, deps: Deps, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const signing = env.BID_TOKEN_SIGNING_KEY?.trim();
  if (!signing) throw new HttpError(503, "Set BID_TOKEN_SIGNING_KEY before issuing a store key.");
  const normalized = domain.trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(normalized)) throw new HttpError(400, "store_domain is not a hostname");
  const raw = newStoreKey();
  try {
    await deps.store.saveStoreKey({
      store_domain: normalized,
      key_hmac: storeKeyHmac(signing, normalized, raw),
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof StoreUnavailableError) throw new HttpError(503, "Issuing a key needs a database.");
    throw error;
  }
  return raw;
}

const REPORTS_TO_HIDE = 3;
const AUTO_HIDES_PER_DAY = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function reportNeed(
  id: string,
  input: { reason: string; ipHash: string; deleteToken: string | null },
  deps: Deps,
  now = Date.now(),
) {
  const row = await deps.store.getRequest(id);
  if (!row) throw new HttpError(404, "No stored request with that id");
  if (input.deleteToken) {
    const actual = deleteTokenHmac(deleteTokenKey(), id, input.deleteToken);
    const expected = row.delete_token_hmac ?? "0".repeat(actual.length);
    if (hmacEqual(expected, actual)) {
      try {
        await deps.store.hideRequest(id, new Date(now).toISOString(), "token");
      } catch (error) {
        if (error instanceof StoreUnavailableError) throw new HttpError(503, "Removal needs a database.");
        throw error;
      }
      return { status: "hidden" as const, hidden: true };
    }
  }
  try {
    if (!(await deps.store.hasReport(id, input.ipHash))) {
      await deps.store.saveReport({
        id: randomUUID(),
        request_id: id,
        ip_hash: input.ipHash,
        reason: cleanReason(input.reason),
        created_at: new Date(now).toISOString(),
      });
    }
    const reporters = await deps.store.countReporters(id);
    if (reporters < REPORTS_TO_HIDE) return { status: "review" as const, hidden: false };
    const since = new Date(now - DAY_MS).toISOString();
    if ((await deps.store.countAutoHidesSince(since)) >= AUTO_HIDES_PER_DAY) {
      return { status: "review" as const, hidden: false };
    }
    await deps.store.hideRequest(id, new Date(now).toISOString(), "reports");
  } catch (error) {
    if (error instanceof StoreUnavailableError) throw new HttpError(503, "Removal needs a database.");
    throw error;
  }
  return { status: "hidden" as const, hidden: true };
}

export function publicNeedLabel(need: Partial<ResolvedNeed>): string {
  return publicNeed(normalizeStoredNeed(need)).label;
}

/** Recent requests, public fields only. */
export async function listRecentNeeds(
  deps: Deps,
  limit = 8,
): Promise<Array<{ id: string; created_at: string; need: PublicNeed }>> {
  const rows = await deps.store.listRequests(limit);
  return rows.map((row) => ({
    id: row.id,
    created_at: row.created_at,
    need: publicNeed(normalizeStoredNeed(JSON.parse(row.need_json) as Partial<ResolvedNeed>)),
  }));
}

export type BoardPrice = {
  store_domain: string;
  price: string;
  currency: string;
  product_url: string;
  available: boolean;
  source: "feed" | "bid";
  observed_at: string;
};

export type BoardRow = {
  id: string;
  url: string;
  created_at: string;
  need: PublicNeed;
  stores_answered: number;
  prices: BoardPrice[];
  /** answered: at least one store price. waiting: the watcher has not finished. no_offers: it finished with none. */
  outcome: "answered" | "waiting" | "no_offers";
};

/** What the watcher did for a request. Public: store names and plain reasons, nothing about the shopper. */
export function watchView(run: WatchRun | null) {
  if (!run) return { status: "not_started" as const, stores: [] as Array<{ store_domain: string; status: string; reason: string | null }> };
  return {
    status: run.status,
    finished_at: run.finished_at,
    stores: (run.summary?.stores ?? []).map((item) => ({
      store_domain: item.store_domain,
      source: item.source,
      status: item.status,
      reason: item.reason,
      checkout_route_known: item.checkout_route_known,
    })),
    stopped: run.summary?.stopped ?? null,
  };
}

export const BOARD_LIMIT = 50;

/**
 * The public board. Built only from publicNeed() and public offers, so nothing private can reach it.
 * Hidden requests are left out by the store, and expired ones are purged after 30 days.
 */
export async function boardRows(deps: Deps, limit = BOARD_LIMIT): Promise<BoardRow[]> {
  const rows = await deps.store.listRequests(Math.min(Math.max(1, limit), BOARD_LIMIT));
  const variants = await liveVariants(deps);
  const bids = await deps.store.listBids();
  const watched = await listWatchOffers(deps.store, rows.map((row) => row.id));
  const runs = new Map<string, WatchRun | null>();
  for (const row of rows) runs.set(row.id, await getWatchRun(deps.store, row.id));
  return rows.map((row) => {
    const need = normalizeStoredNeed(JSON.parse(row.need_json) as Partial<ResolvedNeed>);
    const offers = offersFor(need, row.id, variants, bids, "public", watched.get(row.id) ?? [], []).ranked.slice(0, 10);
    const run = runs.get(row.id) ?? null;
    const prices: BoardPrice[] = offers.map((offer) => ({
      store_domain: offer.store_domain,
      price: offer.price,
      currency: offer.currency,
      product_url: offer.product_url,
      available: offer.available,
      source: offer.source,
      observed_at: offer.observed_at,
    }));
    return {
      id: row.id,
      url: `/r/${row.id}`,
      created_at: row.created_at,
      need: publicNeed(need),
      stores_answered: new Set(offers.map((offer) => offer.store_domain)).size,
      prices,
      outcome: offers.length > 0 ? ("answered" as const) : run?.status === "done" ? ("no_offers" as const) : ("waiting" as const),
    };
  });
}

export async function boardFeed(deps: Deps) {
  return {
    board: "HaggleBoard",
    note: "Public fields only. The poster's text, maximum price and held order are never listed.",
    requests: await boardRows(deps),
    disclaimer: DISCLAIMER,
  };
}

export async function importVariants(variants: CatalogVariant[], store: Store): Promise<number> {
  const removed = loadRemoved();
  const kept = variants.filter((variant) => !removed.has(variant.store_domain));
  await store.upsertVariants(kept.map(variantToRow));
  return kept.length;
}

export async function catalogSummary(deps: Deps) {
  const stored = await deps.store.countVariants();
  const variants = await deps.loadVariants();
  const fixture = stored > 0 ? null : readFixture();
  return {
    source: stored > 0 ? ("database" as const) : ("fixture" as const),
    variants: variants.length,
    stores: new Set(variants.map((variant) => variant.store_domain)).size,
    crawled_at: stored > 0 ? await deps.store.latestObserved() : (fixture?.crawled_at ?? null),
    synthetic: stored > 0 ? false : fixture?.synthetic === true,
  };
}

type View = "poster" | "public";

/**
 * poster: the full need, request-bound store offers, and a comparison with the held order.
 * public: product fields only, matched without the private price cap or location, no
 *         request-bound offers and no comparison.
 */
function offersFor(
  need: ResolvedNeed,
  requestId: string | null,
  variants: CatalogVariant[],
  bids: BidRow[],
  view: View,
  watched: CatalogVariant[] = [],
  privateOffers: PrivateOffer[] = [],
) {
  const matchNeed = view === "public" ? productOnly(need) : need;
  const available = matchVariants(variants, matchNeed, true);
  const includingSoldOut = matchVariants(variants, matchNeed, false);
  // Prices the watcher read from stores' own feeds for this request. Newer than the snapshot.
  const fresh = watched.filter((variant) => !isDemoSeller(variant) && productMatches(variant, matchNeed, true));
  const freshUrls = new Set(fresh.map((variant) => variant.product_url));
  const offers = [
    ...fresh.map((variant) => toPublicOffer(variant, "feed")),
    ...available.filter((variant) => !freshUrls.has(variant.product_url)).map((variant) => toPublicOffer(variant, "feed")),
  ];
  // A private offer under a store rule: the poster's view only.
  if (view === "poster") for (const offer of privateOffers) offers.push(privateOfferToOffer(offer));
  for (const row of bids) {
    const stored = JSON.parse(row.bid_json) as StoredBid;
    if (stored.verified !== true || isDemoSeller(stored)) continue;
    if (requestId && row.request_id === requestId) {
      if (view === "poster") offers.push(bidToOffer(stored, row.created_at));
      continue;
    }
    if (!row.request_id && variantMatches(bidAsVariant(stored, row.created_at), matchNeed, true)) {
      offers.push(bidToOffer(stored, row.created_at));
    }
  }
  return { ranked: rankOffers(offers), omitted: Math.max(0, includingSoldOut.length - available.length) };
}

async function collectOffers(need: ResolvedNeed, requestId: string | null, deps: Deps, limit: number, view: View) {
  const variants = await liveVariants(deps);
  const bids = await deps.store.listBids();
  const watched = requestId ? ((await listWatchOffers(deps.store, [requestId])).get(requestId) ?? []) : [];
  const privateOffers = requestId && view === "poster" ? await listPrivateOffers(deps.store, requestId) : [];
  const { ranked, omitted } = offersFor(need, requestId, variants, bids, view, watched, privateOffers);
  const sliced = ranked.slice(0, limit);
  if (view === "public") {
    return { need: publicNeed(need) as PublicNeed | ResolvedNeed, offers: sliced.map(publicOffer), omitted_unavailable: omitted };
  }
  const holding = need.holding;
  const offers = holding
    ? sliced.map((offer) => ({ ...offer, vs_holding: compareWithHolding(offer, holding, need.quantity) }))
    : sliced;
  return { need: need as PublicNeed | ResolvedNeed, offers, omitted_unavailable: omitted };
}

function parseNeedBody(input: unknown): z.infer<typeof needSchema> {
  const parsed = needSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : null;
    const custom = issue && issue.code === "custom" ? issue.message : null;
    const regex = issue && issue.code === "invalid_format" ? issue.message : null;
    const detail = custom ?? regex ?? (where ? `check ${where}` : null);
    throw new HttpError(400, detail ? `The need is not valid: ${detail}` : "The need is not valid");
  }
  return parsed.data;
}

/** Posting needs only a description: free text, a brand, a model or a barcode. No price needed. */
function assertPostable(need: ResolvedNeed) {
  if (!need.text && !need.brand && !need.model && !need.gtin) {
    throw new HttpError(400, "Say what you are looking for: send text, or a brand and model, or a gtin");
  }
}

function assertSearchable(need: ResolvedNeed) {
  if (needIsEmpty(need) || (!need.brand && !need.model && !need.size && !need.gtin)) {
    throw new HttpError(400, "Name a brand, model, size, or gtin");
  }
}

export function toPublicOffer(
  variant: CatalogVariant,
  source: "feed" | "bid",
  extra?: Partial<Pick<PublicOffer, "shipping" | "delivery_days" | "returns_days" | "note" | "verified">>,
): PublicOffer {
  return {
    store_domain: variant.store_domain,
    brand: variant.brand,
    model: variant.model,
    title: variant.title,
    gender: variant.gender,
    size: variant.size,
    color: variant.color,
    available: variant.available,
    price: variant.price,
    price_cents: variant.price_cents,
    compare_at_price: variant.compare_at_price,
    compare_at_cents: variant.compare_at_cents,
    currency: variant.currency,
    product_url: variant.product_url,
    source,
    observed_at: variant.observed_at,
    shipping: extra?.shipping ?? null,
    delivery_days: extra?.delivery_days ?? null,
    returns_days: extra?.returns_days ?? null,
    note: extra?.note ?? null,
    checkout: "store_site",
    verified: source === "bid" ? extra?.verified === true : null,
  };
}

function privateOfferToOffer(offer: PrivateOffer): PublicOffer {
  return {
    store_domain: offer.store_domain,
    brand: "",
    model: "",
    title: offer.title,
    gender: "unknown",
    size: offer.hbp.terms.item.size,
    color: offer.hbp.terms.item.color,
    available: true,
    price: offer.price,
    price_cents: offer.price_cents,
    compare_at_price: offer.public_price,
    compare_at_cents: Math.round(Number(offer.public_price) * 100),
    currency: offer.currency,
    product_url: offer.product_url,
    source: "bid",
    observed_at: offer.created_at,
    shipping: null,
    delivery_days: null,
    returns_days: null,
    note: `Private offer from this store under its standing rule. Only you see it. Expires ${offer.expires_at}.`,
    checkout: "store_site",
    verified: true,
    expires_at: offer.expires_at,
    hbp: offer.hbp,
  };
}

function bidToOffer(bid: StoredBid, observedAt: string): PublicOffer {
  const variant = bidAsVariant(bid, observedAt);
  return toPublicOffer(variant, "bid", {
    shipping: bid.shipping ?? null,
    delivery_days: bid.delivery_days ?? null,
    returns_days: bid.returns_days ?? null,
    note: bid.note ?? null,
    verified: bid.verified === true,
  });
}

function bidAsVariant(bid: StoredBid, observedAt: string): CatalogVariant {
  const cents = toCents(bid.price) ?? 0;
  const compare = bid.compare_at_price == null ? null : toCents(bid.compare_at_price);
  const origin = new URL(bid.product_url).origin;
  return {
    id: bid.id,
    store_domain: bid.store_domain,
    shop_origin: origin,
    country: null,
    region: null,
    brand: bid.brand ?? "",
    model: bid.model ?? bid.title ?? "",
    title: bid.title ?? [bid.brand, bid.model].filter(Boolean).join(" "),
    gender: (bid.gender ?? "unknown") as Gender,
    size: canonicalSize(bid.size ?? null),
    size_raw: bid.size ?? null,
    size_system: null,
    size_men: null,
    size_women: null,
    width: null,
    color: bid.color ?? null,
    available: bid.available !== false,
    price: centsToDecimal(cents),
    price_cents: cents,
    compare_at_price: compare == null ? null : centsToDecimal(compare),
    compare_at_cents: compare,
    currency: bid.currency,
    product_url: bid.product_url,
    handle: "",
    external_product_id: bid.id,
    external_variant_id: bid.id,
    category: "shoe",
    observed_at: observedAt,
  };
}

function cleanReason(value: string): string | null {
  const cleaned = value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200);
  return cleaned || null;
}

function assertCheckoutUrl(domain: string, url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(400, "product_url must be a URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new HttpError(400, "product_url must be an https link with no embedded credentials");
  }
  if (!hostMatchesDomain(parsed.hostname, domain)) {
    throw new HttpError(400, "product_url must point at the store's own site");
  }
}
