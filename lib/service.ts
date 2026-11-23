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
import {
  AUCTION_MAX_SECONDS,
  AUCTION_MIN_SECONDS,
  clampWindow,
  eventsWithLazyClose,
  offerEvents,
  offersFromEvents,
  posterAuction,
  windowFor,
  windowFromEvents,
  withdrawEvents,
  withdrawnStores,
  type IncomingOffer,
  type WithdrawReason,
} from "./auction.js";
import { eventStatement, requestEvents, requestIsInternal, serviceContext, type EventContext, type NewEvent } from "./events.js";
import { scrubPublicText as scrubText } from "./privacy.js";

export type Deps = {
  loadVariants: () => Promise<CatalogVariant[]>;
  store: Store;
  /** Where the current request came from (lib/origin.ts). Defaults to "test" under tests, else "internal". */
  origin?: RequestOrigin;
  /** Called after a request is stored. The app routes use it to run the watcher when WATCHER_INLINE is on. */
  afterPost?: (request: { id: string; need: ResolvedNeed; origin: RequestOrigin }) => void;
  /** Who is calling, for the event log (lib/events.ts). Defaults to our own service traffic. */
  context?: EventContext;
  /** One-address posting (/find): a hash of the query, kept privately so a repeat can be found. */
  findKey?: string;
};

function contextOf(deps: Deps): EventContext {
  return deps.context ?? serviceContext();
}

const RESERVED_HANDLES = new Set(["admin", "haggleboard", "anonymous", "unknown", "internal", "test", "api", "root", "support"]);

/** An optional public name an agent can post under, for its scorecard. Not a person's name or contact. */
export const handleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{2,31}$/, "handle must be 3 to 32 letters, digits, - or _")
  .refine((value) => !/\d{7,}/.test(value), "handle must not look like a phone number")
  .refine((value) => !RESERVED_HANDLES.has(value), "that handle is reserved");

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
  auction_seconds: z.number().int().min(AUCTION_MIN_SECONDS).max(AUCTION_MAX_SECONDS).optional(),
  handle: handleSchema.optional(),
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
  const now = Date.now();
  const created_at = new Date(now).toISOString();
  const delete_token = newDeleteToken();
  let persisted = false;
  const origin = deps.origin ?? defaultOrigin();
  const ctx = contextOf(deps);
  const window = windowFor(created_at, clampWindow(body.auction_seconds));
  if (deps.store.kind !== "unavailable") {
    try {
      const snapshot = snapshotOffers(need, await liveVariants(deps));
      const opened = postedEvents(id, need, window, ctx, body.handle ?? null, created_at, deps.findKey ?? null);
      const offered = offerEvents(id, window, [], snapshot, now).events;
      // The request, request.posted, request.holding, and the opening offers: one transaction.
      await deps.store.saveRequest(
        {
          id,
          need_json: JSON.stringify(need),
          created_at,
          delete_token_hmac: deleteTokenHmac(deleteTokenKey(), id, delete_token),
          origin,
        },
        [...opened, ...offered].map((event) => eventStatement(event, ctx)),
      );
      persisted = true;
    } catch (error) {
      if (!(error instanceof StoreUnavailableError)) throw error;
    }
  }
  if (persisted) deps.afterPost?.({ id, need, origin });
  const result = await collectOffers(need, persisted ? id : null, deps, body.limit ?? 20, "poster");
  const auction = persisted ? posterAuction(await requestEvents(deps.store, id)) : null;
  return {
    id,
    persisted,
    created_at,
    delete_token: persisted ? delete_token : null,
    board_url: persisted ? `/r/${id}` : null,
    need,
    handle: persisted ? (body.handle ?? null) : null,
    offers: result.offers,
    omitted_unavailable: result.omitted_unavailable,
    auction: auction ? { ...auction, ...pollHints(id) } : null,
    hint: needHint(need, result.offers.length, persisted),
    privacy: PRIVACY_NOTE,
    checkout: "store_site" as const,
    disclaimer: DISCLAIMER,
  };
}

function pollHints(id: string) {
  return {
    next: "Call get_result with request_id and delete_token. Each call waits up to 25 seconds and returns the winner once the window has closed.",
    result_url: `/api/requests/${id}/result`,
    public_stream: `/api/requests/${id}/stream`,
    public_events: `/api/requests/${id}/events`,
  };
}

/** Public prices already in the snapshot, one per store: the auction's opening field. */
function snapshotOffers(need: ResolvedNeed, variants: CatalogVariant[]): IncomingOffer[] {
  if (!need.brand && !need.model && !need.gtin) return [];
  const best = new Map<string, CatalogVariant>();
  for (const variant of matchVariants(variants, productOnly(need), false)) {
    const current = best.get(variant.store_domain);
    if (
      !current ||
      (variant.available && !current.available) ||
      (variant.available === current.available && variant.price_cents < current.price_cents)
    ) {
      best.set(variant.store_domain, variant);
    }
  }
  return [...best.values()]
    .slice(0, 20)
    .map((variant) => ({ ...variantOffer(variant, "snapshot"), confirmed: false, observed_at: variant.observed_at ?? null }));
}

export function variantOffer(variant: CatalogVariant, via: string): IncomingOffer {
  return {
    store_domain: variant.store_domain,
    source: "public_price",
    via,
    price_cents: variant.price_cents,
    currency: variant.currency,
    available: variant.available,
    product_url: variant.product_url,
    title: variant.title,
    expires_at: null,
  };
}

const MARKETPLACES = ["amazon", "ebay", "walmart", "target", "etsy", "temu", "aliexpress", "zalando", "bestbuy", "rakuten", "mercadolibre"];

/** marketplace, brand_site, retailer or unknown. The seller's own name is never logged. */
export function sellerClass(seller: string | null, brand: string | null): "marketplace" | "brand_site" | "retailer" | "unknown" {
  if (!seller) return "unknown";
  const key = seller.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (MARKETPLACES.some((name) => key.includes(name))) return "marketplace";
  const brandKeyValue = (brand ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (brandKeyValue && key.includes(brandKeyValue)) return "brand_site";
  return "retailer";
}

function postedEvents(
  id: string,
  need: ResolvedNeed,
  window: ReturnType<typeof windowFor>,
  ctx: EventContext,
  handle: string | null,
  at: string,
  findKey: string | null = null,
): NewEvent[] {
  const pub = publicNeed(need);
  const events: NewEvent[] = [
    {
      type: "request.posted",
      at,
      request_id: id,
      public: {
        label: pub.label,
        brand: pub.brand,
        model: pub.model,
        gtin: pub.gtin,
        gender: pub.gender,
        size: pub.size,
        color: pub.color,
        category: pub.category,
        channel: ctx.channel,
        agent_kind: ctx.agent.kind,
        signature_agent: ctx.agent.signature_agent,
        signature_verified: false,
        stated_cap: need.max_price_cents != null,
        holding: need.holding != null,
        window_seconds: window.window_seconds,
        deadline: window.deadline,
        handle,
      },
      private: {
        max_price_cents: need.max_price_cents,
        currency: need.currency,
        country: need.country,
        region: need.region,
        quantity: need.quantity,
        attributes: need.attributes,
        ...(findKey ? { find_key: findKey } : {}),
      },
    },
  ];
  if (need.holding) {
    events.push({
      type: "request.holding",
      at,
      request_id: id,
      public: {},
      private: {
        seller_class: sellerClass(need.holding.seller, need.brand),
        price_cents: need.holding.price_cents,
        currency: need.holding.currency,
        delivered: need.holding.delivered,
        delivery_by: need.holding.delivery_by,
      },
    });
  }
  return events;
}

/**
 * Writes offers for a request into the log, with any lead change, in one transaction together with
 * `also` (the row the offers came from). Used by the watcher, store rules and the bid API.
 */
export async function recordOffers(
  store: Store,
  requestId: string,
  incoming: IncomingOffer[],
  opts: { now?: number; also?: Array<[string, unknown[]]>; agent_class?: string } = {},
): Promise<void> {
  if (store.kind === "unavailable") return;
  const events = await requestEvents(store, requestId);
  const window = windowFromEvents(events);
  const internal = await requestIsInternal(store, requestId);
  const made = incoming.length
    ? offerEvents(requestId, window, offersFromEvents(events), incoming, opts.now ?? Date.now()).events
    : [];
  await store.batch([
    ...(opts.also ?? []),
    // Test-store events (TEST_STORES) are always internal, whatever the request was.
    ...made.map((event) =>
      eventStatement({ ...event, internal: event.internal === true || internal, agent_class: opts.agent_class ?? "haggleboard" }, null),
    ),
  ]);
}

/**
 * A live read found the item missing or sold out at a store: withdraw that store's unconfirmed
 * snapshot offer (offer.withdrawn, plus lead.changed when it was leading), in one transaction.
 */
export async function withdrawOffer(
  store: Store,
  requestId: string,
  storeDomain: string,
  reason: WithdrawReason,
  now = Date.now(),
): Promise<boolean> {
  if (store.kind === "unavailable") return false;
  const events = await requestEvents(store, requestId);
  const made = withdrawEvents(requestId, windowFromEvents(events), offersFromEvents(events), storeDomain, reason, now);
  if (made.length === 0) return false;
  const internal = await requestIsInternal(store, requestId);
  await store.batch(made.map((event) => eventStatement({ ...event, internal: event.internal === true || internal, agent_class: "haggleboard" }, null)));
  return true;
}

function needHint(need: ResolvedNeed, offers: number, persisted = true): string | null {
  if (!persisted) return "Nothing was stored: this server has no database, so there is no auction and no request page.";
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
    const events = await eventsWithLazyClose(deps.store, body.request_id);
    const window = windowFromEvents(events);
    const auction =
      view === "poster"
        ? posterAuction(events)
        : window
          ? {
              status: events.some((event) => event.type === "auction.closed") ? ("closed" as const) : ("open" as const),
              deadline: window.deadline,
              public_stream: `/api/requests/${body.request_id}/stream`,
              public_events: `/api/requests/${body.request_id}/events`,
            }
          : null;
    return {
      request_id: body.request_id,
      view,
      created_at: row.created_at,
      need: result.need,
      offers: result.offers,
      omitted_unavailable: result.omitted_unavailable,
      auction,
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

export const RESULT_MAX_WAIT_SECONDS = 25;
const RESULT_DEFAULT_WAIT_SECONDS = 20;

const resultSchema = z.object({
  request_id: z.string().uuid(),
  delete_token: z.string().trim().min(16).max(200),
  wait_seconds: z.number().int().min(0).max(RESULT_MAX_WAIT_SECONDS).optional(),
});

async function posterRow(deps: Deps, requestId: string, token: string) {
  const row = await deps.store.getRequest(requestId);
  if (!row) throw new HttpError(404, "No stored request with that id");
  if (!posterTokenMatches(row, token)) throw new HttpError(403, "That delete_token does not match this request");
  return { row, need: normalizeStoredNeed(JSON.parse(row.need_json) as Partial<ResolvedNeed>) };
}

/**
 * The poster's one call after posting: the current standing with amounts, and once the window has
 * closed, the winning offer with its checkout link. Waits up to wait_seconds (default 20) for the close.
 */
export async function getResult(
  input: unknown,
  deps: Deps,
  opts: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
) {
  const parsed = resultSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "Send request_id and delete_token from post_request");
  const { request_id, delete_token } = parsed.data;
  await posterRow(deps, request_id, delete_token);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const until = now() + (parsed.data.wait_seconds ?? RESULT_DEFAULT_WAIT_SECONDS) * 1000;
  for (;;) {
    const events = await eventsWithLazyClose(deps.store, request_id, { now: now() });
    const auction = posterAuction(events, now());
    if (!auction || auction.status === "closed" || now() >= until) {
      const outcome = [...events].reverse().find((event) => event.type === "outcome.reported");
      return {
        request_id,
        view: "poster" as const,
        auction,
        outcome_reported: outcome ? String(outcome.public.outcome) : null,
        next: !auction
          ? "This request has no auction window (it was posted before auctions existed)."
          : auction.status === "closed"
            ? auction.winner
              ? "Send your user to winner.checkout_url and let them check out on the store's own site. Then call report_outcome."
              : "No store answered in time. Call report_outcome with did_not_buy or bought_elsewhere."
            : `Still open, about ${auction.seconds_left} seconds left. Call get_result again.`,
        checkout: "store_site" as const,
        disclaimer: DISCLAIMER,
      };
    }
    const closesAt = Date.parse(auction.deadline) + 2_100;
    await sleep(Math.max(250, Math.min(2_000, until - now(), closesAt - now())));
  }
}

export const OUTCOMES = ["bought_at_winner", "bought_elsewhere", "did_not_buy"] as const;

const outcomeSchema = z.object({
  request_id: z.string().uuid(),
  delete_token: z.string().trim().min(16).max(200),
  outcome: z.enum(OUTCOMES),
  reason: z.string().trim().max(200).optional(),
});

/** What the posting agent did. The latest report counts. The reason is private and dropped after 30 days. */
export async function reportOutcome(input: unknown, deps: Deps) {
  const parsed = outcomeSchema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError(400, `Send request_id, delete_token and outcome (${OUTCOMES.join(", ")}), and optionally a short reason`);
  }
  const { request_id, delete_token, outcome } = parsed.data;
  if (deps.store.kind === "unavailable") throw new HttpError(503, "Reporting an outcome needs DATABASE_URL.");
  await posterRow(deps, request_id, delete_token);
  const events = await eventsWithLazyClose(deps.store, request_id);
  const closed = events.find((event) => event.type === "auction.closed");
  if (outcome === "bought_at_winner" && closed && !closed.public.winner) {
    throw new HttpError(409, "This auction closed with no winner. Use bought_elsewhere or did_not_buy.");
  }
  const ctx = contextOf(deps);
  const internal = (await requestIsInternal(deps.store, request_id)) || ctx.internal;
  const reason = scrubText(parsed.data.reason ?? null);
  await deps.store.batch([
    eventStatement(
      {
        type: "outcome.reported",
        request_id,
        store_domain: outcome === "bought_at_winner" ? (closed?.store_domain ?? null) : null,
        internal,
        public: { outcome, auction_closed: Boolean(closed), reason_given: reason != null },
        private: reason ? { reason } : {},
      },
      ctx,
    ),
  ]);
  return { request_id, recorded: true, outcome, disclaimer: DISCLAIMER };
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
    if (parsed.data.request_id) {
      // The bid row and its offer.made (amount private) in one transaction.
      const offer = bidToOffer(stored, created_at);
      await recordOffers(
        deps.store,
        parsed.data.request_id,
        [
          {
            store_domain: offer.store_domain,
            source: "store_bid",
            via: "bid_api",
            price_cents: offer.price_cents,
            currency: offer.currency,
            available: offer.available,
            product_url: offer.product_url,
            title: offer.title,
            expires_at: null,
            delivery_days: offer.delivery_days,
            returns_days: offer.returns_days,
          },
        ],
        {
          also: [[INSERT_BID_SQL, [id, parsed.data.request_id, parsed.data.store_domain, actual, JSON.stringify(stored), created_at]]],
          agent_class: contextOf(deps).agent.agent_class,
        },
      );
    } else {
      await deps.store.saveBid({
        id,
        request_id: null,
        store_domain: parsed.data.store_domain,
        key_hash: actual,
        bid_json: JSON.stringify(stored),
        created_at,
      });
    }
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
    const now = new Date();
    const first = (
      await deps.store.select("SELECT MIN(at) AS at FROM events WHERE type = 'store.notified' AND store_domain = ?", [normalized])
    )[0]?.at;
    // The key and store.claimed in one transaction.
    await deps.store.batch([
      [UPSERT_STORE_KEY_SQL, [normalized, storeKeyHmac(signing, normalized, raw), now.toISOString()]],
      eventStatement(
        {
          type: "store.claimed",
          store_domain: normalized,
          public: { since_first_notification_ms: first == null ? null : now.getTime() - Date.parse(String(first)) },
        },
        contextOf(deps),
      ),
    ]);
  } catch (error) {
    if (error instanceof StoreUnavailableError) throw new HttpError(503, "Issuing a key needs a database.");
    throw error;
  }
  return raw;
}

const INSERT_BID_SQL = `INSERT INTO bids (id, request_id, store_domain, key_hash, bid_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`;
const UPSERT_STORE_KEY_SQL = `INSERT INTO store_keys (store_domain, key_hmac, created_at) VALUES (?, ?, ?)
ON CONFLICT(store_domain) DO UPDATE SET key_hmac = excluded.key_hmac, created_at = excluded.created_at`;

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
  const withdrawnBy = new Map<string, Set<string>>();
  for (const row of rows) {
    runs.set(row.id, await getWatchRun(deps.store, row.id));
    withdrawnBy.set(row.id, new Set(withdrawnStores(await requestEvents(deps.store, row.id)).map((item) => item.store_domain)));
  }
  return rows.map((row) => {
    const need = normalizeStoredNeed(JSON.parse(row.need_json) as Partial<ResolvedNeed>);
    const offers = offersFor(need, row.id, variants, bids, "public", watched.get(row.id) ?? [], [], withdrawnBy.get(row.id)).ranked.slice(0, 10);
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
  withdrawn: Set<string> = new Set(),
) {
  const matchNeed = view === "public" ? productOnly(need) : need;
  // A live read during this request's auction found the item gone at these stores: their snapshot
  // listing is no longer offered here (stale-price rule (a), lib/auction.ts).
  const kept = withdrawn.size > 0 ? variants.filter((variant) => !withdrawn.has(variant.store_domain)) : variants;
  const available = matchVariants(kept, matchNeed, true);
  const includingSoldOut = matchVariants(kept, matchNeed, false);
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
  const withdrawn = requestId ? new Set(withdrawnStores(await requestEvents(deps.store, requestId)).map((item) => item.store_domain)) : new Set<string>();
  const { ranked, omitted } = offersFor(need, requestId, variants, bids, view, watched, privateOffers, withdrawn);
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
