import { randomUUID } from "node:crypto";
import type { Store } from "./db.js";
import { eventStatement, requestEvents, type EventRow, type NewEvent } from "./events.js";
import { centsToDecimal } from "../referee/money.js";

/**
 * TIMED AUCTIONS, with no long-running process.
 *
 * A stored request opens a window when it is posted (request.posted carries `deadline`). Offers are
 * offer.made events. Whenever an offer is written, the engine ranks the offers made so far and, if
 * first place changed, writes lead.changed in the same transaction. Nothing runs at the deadline:
 * the first read after `deadline + CLOSE_GRACE_MS` computes the result from offers made up to the
 * deadline and writes auction.closed under a fixed id (`<request id>:auction.closed`, insert-once),
 * so any number of readers, in any order, produce the same single close.
 *
 * STALE PRICES. Every offer carries the time its price was observed and whether it was confirmed
 * live during this auction (a watcher read, a store rule, a keyed bid). A snapshot price is not
 * confirmed. Rules:
 *  (a) a live read during the auction that finds the item missing or sold out at a store withdraws
 *      that store's unconfirmed snapshot offer (offer.withdrawn, shown as "no longer listed");
 *  (b) at the same amount a confirmed price ranks above an unconfirmed one;
 *  (c) an unconfirmed price observed more than STALE_AFTER_DAYS before the auction opened can be
 *      shown but cannot lead or win while any confirmed offer exists. When the best offer left is
 *      unconfirmed, the result is "last_seen", never "won".
 */
export const AUCTION_DEFAULT_SECONDS = 120;
export const AUCTION_MIN_SECONDS = 30;
export const AUCTION_MAX_SECONDS = 600;
/** A short grace so an offer stamped just before the deadline but committed just after still counts. */
export const CLOSE_GRACE_MS = 2_000;
/** An unconfirmed price older than this (at the auction's open) is stale. */
export const STALE_AFTER_DAYS = 7;
export const STALE_AFTER_MS = STALE_AFTER_DAYS * 86_400_000;
/**
 * A store rule beats a held order by about this ratio (watcher/store-rules.ts). The public band of a
 * private offer is checked against an observer who knows this formula (see privateBandDisclosure).
 */
export const HELD_UNDERCUT_RATIO = 0.99;

export type OfferSource = "public_price" | "private_offer" | "store_bid";

export type AuctionOffer = {
  event_id: string;
  at: string;
  store_domain: string;
  source: OfferSource;
  via: string;
  price_cents: number;
  currency: string;
  available: boolean;
  product_url: string;
  title: string | null;
  expires_at: string | null;
  /** When the price was observed. A snapshot price keeps its crawl time. */
  observed_at: string | null;
  /** True when the price was read or made live during this auction. */
  confirmed: boolean;
  /** Made by a fictional test store (TEST_STORES=1). Never real store activity. */
  test?: boolean;
  /** A private offer under a store rule: the rule's maximum discount (private; its band is public). */
  discount_cap_percent?: number | null;
};

export type IncomingOffer = Omit<AuctionOffer, "event_id" | "at" | "observed_at" | "confirmed"> & {
  delivery_days?: number | null;
  returns_days?: number | null;
  /** Defaults to the time the offer is written. */
  observed_at?: string | null;
  /** Defaults to true for anything but a snapshot price. */
  confirmed?: boolean;
};

export type Band =
  | "no_public_price"
  | "not_compared"
  | "above_public"
  | "at_public"
  | "under_0_5"
  | "under_5_10"
  | "under_10_20"
  | "under_20_plus"
  /** A private offer's public band: within 5% of the best public price, either side (coarser on purpose). */
  | "near_public"
  /** A private offer whose band is not shown, because showing it could narrow the held price. */
  | "withheld";

export const BAND_LABELS: Record<Band, string> = {
  no_public_price: "no public price to compare with",
  not_compared: "different currency from the best public price",
  above_public: "above the best public price",
  at_public: "at the best public price",
  under_0_5: "up to 5% under the best public price",
  under_5_10: "5 to 10% under the best public price",
  under_10_20: "10 to 20% under the best public price",
  under_20_plus: "more than 20% under the best public price",
  near_public: "within 5% of the best public price",
  withheld: "private offer",
};

export type ResultKind = "won" | "last_seen" | "none";

export const RESULT_LAST_SEEN_LABEL = "Best last-seen price, not confirmed today";

export type AuctionWindow = { opened_at: string; deadline: string; window_seconds: number };

export function clampWindow(seconds: number | null | undefined): number {
  if (seconds == null || !Number.isFinite(seconds)) return AUCTION_DEFAULT_SECONDS;
  return Math.min(AUCTION_MAX_SECONDS, Math.max(AUCTION_MIN_SECONDS, Math.round(seconds)));
}

export function windowFor(openedAt: string, seconds: number): AuctionWindow {
  return {
    opened_at: openedAt,
    deadline: new Date(Date.parse(openedAt) + seconds * 1000).toISOString(),
    window_seconds: seconds,
  };
}

export function windowFromEvents(events: EventRow[]): AuctionWindow | null {
  const posted = events.find((event) => event.type === "request.posted");
  const deadline = posted?.public.deadline;
  const seconds = posted?.public.window_seconds;
  if (!posted || typeof deadline !== "string" || typeof seconds !== "number") return null;
  return { opened_at: posted.at, deadline, window_seconds: seconds };
}

export function offerFromEvent(event: EventRow): AuctionOffer | null {
  if (event.type !== "offer.made" || !event.store_domain) return null;
  const cents = Number(event.private.price_cents);
  if (!Number.isFinite(cents)) return null;
  const source = event.public.source;
  if (source !== "public_price" && source !== "private_offer" && source !== "store_bid") return null;
  const via = String(event.public.via ?? "");
  // Events written before these fields existed: a snapshot price was never confirmed, anything else was live.
  const confirmed = typeof event.public.confirmed === "boolean" ? event.public.confirmed : !(source === "public_price" && via === "snapshot");
  const observed =
    typeof event.public.observed_at === "string" ? event.public.observed_at : confirmed ? event.at : null;
  return {
    event_id: event.id,
    at: event.at,
    store_domain: event.store_domain,
    source,
    via,
    price_cents: cents,
    currency: String(event.public.currency ?? ""),
    available: event.public.available !== false,
    product_url: String(event.private.product_url ?? event.public.product_url ?? ""),
    title: event.private.title == null ? null : String(event.private.title),
    expires_at: event.private.expires_at == null ? null : String(event.private.expires_at),
    observed_at: observed,
    confirmed,
    ...(event.public.test === true ? { test: true } : {}),
    ...(typeof event.private.rule_cap_percent === "number" ? { discount_cap_percent: event.private.rule_cap_percent } : {}),
  };
}

/** True for an unconfirmed price observed more than STALE_AFTER_DAYS before `reference`. */
export function isStale(offer: Pick<AuctionOffer, "confirmed" | "observed_at">, reference: string | number): boolean {
  if (offer.confirmed) return false;
  const ref = typeof reference === "number" ? reference : Date.parse(reference);
  const seen = offer.observed_at ? Date.parse(offer.observed_at) : NaN;
  if (!Number.isFinite(seen)) return true;
  return ref - seen > STALE_AFTER_MS;
}

/** Latest offer per store and source, then the best of those per store. */
export function currentOffers(offers: AuctionOffer[]): AuctionOffer[] {
  const latest = new Map<string, AuctionOffer>();
  for (const offer of [...offers].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))) {
    latest.set(`${offer.store_domain}\n${offer.source}`, offer);
  }
  const best = new Map<string, AuctionOffer>();
  for (const offer of rankAuction([...latest.values()])) if (!best.has(offer.store_domain)) best.set(offer.store_domain, offer);
  return rankAuction([...best.values()]);
}

function mainCurrency(offers: AuctionOffer[]): string | null {
  const counts = new Map<string, number>();
  for (const offer of offers) counts.set(offer.currency, (counts.get(offer.currency) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

/**
 * In stock first, then the currency most offers use (mixed currencies are never one scale), then
 * lowest price, then a confirmed price before an unconfirmed one, then who offered first, then
 * store name. Nothing can pay to move up.
 */
export function rankAuction(offers: AuctionOffer[]): AuctionOffer[] {
  const main = mainCurrency(offers);
  return [...offers].sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    if (a.currency !== b.currency) {
      if (a.currency === main) return -1;
      if (b.currency === main) return 1;
      return a.currency.localeCompare(b.currency);
    }
    if (a.price_cents !== b.price_cents) return a.price_cents - b.price_cents;
    if (a.confirmed !== b.confirmed) return a.confirmed ? -1 : 1;
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    return a.store_domain.localeCompare(b.store_domain);
  });
}

/**
 * The standing as it decides the lead and the winner: ranked current offers, with stale unconfirmed
 * offers moved behind everything else whenever any confirmed offer is in stock. `reference` is the
 * auction's open.
 */
export function standingOrder(current: AuctionOffer[], reference: string | number): AuctionOffer[] {
  const ranked = rankAuction(current);
  const anyConfirmed = ranked.some((offer) => offer.available && offer.confirmed);
  if (!anyConfirmed) return ranked;
  const eligible = ranked.filter((offer) => !isStale(offer, reference));
  const parked = ranked.filter((offer) => isStale(offer, reference));
  return [...eligible, ...parked];
}

/** The offer that leads (and would win now), or null. */
export function leaderOf(current: AuctionOffer[], reference: string | number): AuctionOffer | null {
  const first = standingOrder(current, reference)[0] ?? null;
  return first && first.available ? first : null;
}

export function bestPublic(offers: AuctionOffer[], currency: string, reference?: string | number): AuctionOffer | null {
  const publics = offers.filter((offer) => offer.source === "public_price" && offer.available && offer.currency === currency);
  const ordered = reference == null ? rankAuction(publics) : standingOrder(publics, reference);
  return ordered[0] ?? null;
}

/** How far an offer is under the best public price in its currency, as a coarse band. */
export function bandFor(offer: AuctionOffer, offers: AuctionOffer[], reference?: string | number): Band {
  const best = bestPublic(offers, offer.currency, reference);
  if (!best) {
    return offers.some((item) => item.source === "public_price" && item.available) ? "not_compared" : "no_public_price";
  }
  const gap = (best.price_cents - offer.price_cents) / best.price_cents;
  if (gap < 0) return "above_public";
  if (gap === 0) return "at_public";
  if (gap <= 0.05) return "under_0_5";
  if (gap <= 0.1) return "under_5_10";
  if (gap <= 0.2) return "under_10_20";
  return "under_20_plus";
}

/**
 * The bands a private offer can show publicly, as ranges of its price relative to the best public
 * price R: [low, high) as fractions of R. near_public merges at, above and up to 5% under, because a
 * private offer exactly at or just over R would pin the held price.
 */
const PRIVATE_BANDS: Array<{ band: Band; low: number; high: number; width: number }> = [
  { band: "near_public", low: 0.95, high: Number.POSITIVE_INFINITY, width: 0.05 },
  { band: "under_5_10", low: 0.9, high: 0.95, width: 0.05 },
  { band: "under_10_20", low: 0.8, high: 0.9, width: 0.1 },
  { band: "under_20_plus", low: 0, high: 0.8, width: 0.2 },
];

/**
 * PRIVACY RULE for a private offer's public band. The decision uses public information only (the
 * public prices in this auction, among them the store's own public price S), never the offer's own
 * amount, so whether a band is shown says nothing about the held price either.
 *
 * Observer model: knows every public price, the store's own public price S, and that a store rule
 * prices a private offer at about HELD_UNDERCUT_RATIO x the held price H, and that an offer is only
 * made when H <= S. A band [low, high) on the offer then bounds H to [low*R/ratio, high*R/ratio]
 * intersected with H <= S. If that interval could be narrower than the band's own width for ANY
 * band, every private band in this context is withheld. Also withheld when fewer than two public
 * prices exist (one public price, or none, leaves too little to hide in).
 */
export function privateBandDisclosure(input: {
  publicPrices: number[];
  ownPublic: number | null;
  /** The best public price the band is measured against. Defaults to the lowest public price. */
  reference?: number | null;
  /**
   * The store rule's maximum discount, in percent. Its band is public (store.rule_set publishes
   * 0_5, 5_10, 10_20 or 20_plus), so the observer knows the offer is at least S x (1 - band top).
   */
  discountCapPercent?: number | null;
}): { show: boolean; reason: string | null } {
  const prices = input.publicPrices.filter((cents) => Number.isFinite(cents) && cents > 0);
  if (prices.length < 2) return { show: false, reason: "fewer than two public prices" };
  if (input.ownPublic == null || !(input.ownPublic > 0)) return { show: false, reason: "the store's own public price is not known" };
  const R = input.reference != null && input.reference > 0 ? input.reference : Math.min(...prices);
  const S = input.ownPublic;
  const cap = input.discountCapPercent;
  const capTop = cap == null ? 50 : cap <= 5 ? 5 : cap <= 10 ? 10 : cap <= 20 ? 20 : 50;
  const offerFloor = S * (1 - capTop / 100);
  for (const item of PRIVATE_BANDS) {
    const offerLow = Math.max(item.low * R, offerFloor);
    const offerHigh = Number.isFinite(item.high) ? item.high * R : Number.POSITIVE_INFINITY;
    if (offerHigh <= offerLow) continue;
    // H is about offer / ratio, and an offer is only made when H <= S.
    const low = offerLow / HELD_UNDERCUT_RATIO;
    const high = Math.min(offerHigh / HELD_UNDERCUT_RATIO, S);
    if (high <= low) continue;
    if (high - low < item.width * R) return { show: false, reason: "the band would narrow the held price" };
  }
  return { show: true, reason: null };
}

/** The band anyone can see for an offer. Public prices and keyed bids: the plain band. Private offers: see privateBandDisclosure. */
export function publicBandFor(offer: AuctionOffer, current: AuctionOffer[], all: AuctionOffer[], reference?: string | number): Band {
  const plain = bandFor(offer, current, reference);
  if (offer.source !== "private_offer") return plain;
  // Every public price shown in this auction is public information, old or new, so all count here.
  const publics = new Map<string, number>();
  for (const item of current) {
    if (item.source !== "public_price" || !item.available || item.currency !== offer.currency) continue;
    publics.set(item.store_domain, Math.min(publics.get(item.store_domain) ?? Infinity, item.price_cents));
  }
  // The store's own public price for this item: its latest public offer in this auction.
  const own = [...all]
    .filter((item) => item.store_domain === offer.store_domain && item.source === "public_price" && item.currency === offer.currency)
    .sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  // The store's own public price also counts as a public price on its own line.
  if (own && own.available) publics.set(own.store_domain, Math.min(publics.get(own.store_domain) ?? Infinity, own.price_cents));
  const best = bestPublic(current, offer.currency, reference);
  const disclosure = privateBandDisclosure({
    publicPrices: [...publics.values()],
    ownPublic: own ? own.price_cents : null,
    reference: best?.price_cents ?? null,
    discountCapPercent: offer.discount_cap_percent ?? null,
  });
  if (!disclosure.show) return "withheld";
  if (plain === "at_public" || plain === "above_public" || plain === "under_0_5") return "near_public";
  if (plain === "no_public_price" || plain === "not_compared") return "withheld";
  return plain;
}

function leadEvent(requestId: string, at: string, leader: AuctionOffer, before: AuctionOffer | null, band: Band, test: boolean, plainBand: Band): NewEvent {
  return {
    type: "lead.changed",
    at,
    request_id: requestId,
    store_domain: leader.store_domain,
    ...(test ? { internal: true } : {}),
    public: {
      store: leader.store_domain,
      source: leader.source,
      band,
      band_label: BAND_LABELS[band],
      previous_store: before?.store_domain ?? null,
      confirmed: leader.confirmed,
      observed_at: leader.observed_at,
      ...(test ? { test: true } : {}),
    },
    private: { price_cents: leader.price_cents, currency: leader.currency, plain_band: plainBand },
  };
}

function sameLeader(a: AuctionOffer | null, b: AuctionOffer | null): boolean {
  if (!a || !b) return a === b;
  return a.store_domain === b.store_domain && a.source === b.source;
}

/**
 * offer.made events for incoming offers, plus lead.changed whenever first place changes. Offers
 * made after the deadline are still recorded (`after_close: true`) and never change the result.
 */
export function offerEvents(
  requestId: string,
  window: AuctionWindow | null,
  prior: AuctionOffer[],
  incoming: IncomingOffer[],
  now = Date.now(),
): { events: NewEvent[]; offers: AuctionOffer[] } {
  const events: NewEvent[] = [];
  const known = [...prior];
  const reference = window?.opened_at ?? new Date(now).toISOString();
  for (const [index, item] of incoming.entries()) {
    // One millisecond apart, so offers written together keep their order in the log and the stream.
    const at = new Date(now + index).toISOString();
    const id = randomUUID();
    const confirmed = item.confirmed ?? !(item.source === "public_price" && item.via === "snapshot");
    const observedAt = item.observed_at ?? (confirmed ? at : null);
    const { delivery_days, returns_days, ...rest } = item;
    const offer: AuctionOffer = { ...rest, event_id: id, at, observed_at: observedAt, confirmed };
    const afterClose = window ? at > window.deadline : true;
    const isPublic = item.source === "public_price";
    const test = item.test === true;
    events.push({
      id,
      type: "offer.made",
      at,
      request_id: requestId,
      store_domain: item.store_domain,
      ...(test ? { internal: true } : {}),
      public: {
        source: item.source,
        via: item.via,
        currency: item.currency,
        available: item.available,
        public_price: isPublic ? centsToDecimal(item.price_cents) : null,
        product_url: isPublic ? item.product_url : null,
        delivery_days: delivery_days ?? null,
        returns_days: returns_days ?? null,
        round: 1,
        since_post_ms: window ? Math.max(0, now - Date.parse(window.opened_at)) : null,
        after_close: afterClose,
        confirmed,
        observed_at: observedAt,
        stale: isStale(offer, reference),
        ...(test ? { test: true } : {}),
      },
      private: {
        price_cents: item.price_cents,
        price: centsToDecimal(item.price_cents),
        product_url: item.product_url,
        title: item.title,
        expires_at: item.expires_at,
        ...(item.discount_cap_percent != null ? { rule_cap_percent: item.discount_cap_percent } : {}),
      },
    });
    if (afterClose || !window) continue;
    const before = leaderOf(currentOffers(known), reference);
    known.push(offer);
    const ranked = currentOffers(known);
    const after = leaderOf(ranked, reference);
    if (after && !sameLeader(before, after)) {
      events.push(leadEvent(requestId, at, after, before, publicBandFor(after, ranked, known, reference), after.test === true, bandFor(after, ranked, reference)));
    }
  }
  return { events, offers: known };
}

export type WithdrawReason = "not_found" | "out_of_stock";

/**
 * A live read during the auction found the item missing or sold out at a store: its unconfirmed
 * snapshot offer is withdrawn and can no longer lead or win. Returns offer.withdrawn, plus
 * lead.changed when the withdrawn store was leading and another offer takes over. Nothing when the
 * store had no unconfirmed offer in this auction, or after the close.
 */
export function withdrawEvents(
  requestId: string,
  window: AuctionWindow | null,
  prior: AuctionOffer[],
  storeDomain: string,
  reason: WithdrawReason,
  now = Date.now(),
): NewEvent[] {
  if (!window) return [];
  const at = new Date(now).toISOString();
  if (at > window.deadline) return [];
  const withdrawn = prior.filter((offer) => offer.store_domain === storeDomain && !offer.confirmed && offer.source === "public_price");
  if (withdrawn.length === 0) return [];
  const reference = window.opened_at;
  const before = leaderOf(currentOffers(prior), reference);
  const remaining = prior.filter((offer) => !withdrawn.includes(offer));
  const ranked = currentOffers(remaining);
  const after = leaderOf(ranked, reference);
  const events: NewEvent[] = [
    {
      type: "offer.withdrawn",
      at,
      request_id: requestId,
      store_domain: storeDomain,
      public: {
        reason,
        label: "no longer listed",
        observed_at: withdrawn[0]!.observed_at,
        offer_event_ids: withdrawn.map((offer) => offer.event_id),
      },
    },
  ];
  if (after && !sameLeader(before, after)) {
    events.push(leadEvent(requestId, new Date(now + 1).toISOString(), after, before, publicBandFor(after, ranked, remaining, reference), after.test === true, bandFor(after, ranked, reference)));
  }
  return events;
}

/** Withdrawals in the log: store domain to the time of the first withdrawal. */
export function withdrawalsFromEvents(events: EventRow[], until?: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "offer.withdrawn" || !event.store_domain) continue;
    if (until && event.at > until) continue;
    if (!out.has(event.store_domain)) out.set(event.store_domain, event.at);
  }
  return out;
}

/** Prior offers for a request, from its log. Withdrawn snapshot offers are left out. */
export function offersFromEvents(events: EventRow[], until?: string): AuctionOffer[] {
  const withdrawn = withdrawalsFromEvents(events, until);
  return events
    .filter((event) => event.type === "offer.made" && event.public.after_close !== true && (!until || event.at <= until))
    .map(offerFromEvent)
    .filter((offer): offer is AuctionOffer => offer !== null)
    .filter((offer) => {
      const when = withdrawn.get(offer.store_domain);
      return !(when && !offer.confirmed && offer.source === "public_price" && offer.at <= when);
    });
}

export type ClosedResult = {
  winner: AuctionOffer | null;
  result: ResultKind;
  band: Band | null;
  /** The band before the privacy rule. Private: poster view and export only. */
  plain_band: Band | null;
  bidders: number;
  lead_changes: number;
  beat_public: boolean;
  test: boolean;
};

export function computeClose(events: EventRow[], window: AuctionWindow): ClosedResult {
  const offers = offersFromEvents(events, window.deadline);
  const allOffers = events
    .filter((event) => event.type === "offer.made" && event.public.after_close !== true && event.at <= window.deadline)
    .map(offerFromEvent)
    .filter((offer): offer is AuctionOffer => offer !== null);
  const ranked = currentOffers(offers);
  const winner = leaderOf(ranked, window.opened_at);
  const plain = winner ? bandFor(winner, ranked, window.opened_at) : null;
  const band = winner ? publicBandFor(winner, ranked, offers, window.opened_at) : null;
  return {
    winner,
    result: !winner ? "none" : winner.confirmed ? "won" : "last_seen",
    band,
    plain_band: plain,
    bidders: new Set(allOffers.map((offer) => offer.store_domain)).size,
    lead_changes: events.filter((event) => event.type === "lead.changed" && event.at <= window.deadline).length,
    beat_public: plain != null && plain.startsWith("under_") && winner?.source !== "public_price",
    test: allOffers.some((offer) => offer.test === true),
  };
}

export function closedEventId(requestId: string): string {
  return `${requestId}:auction.closed`;
}

/**
 * Returns the request's events, closing the auction first when its deadline (plus grace) has
 * passed and no close is recorded. Safe to call from any read, any number of times.
 */
export async function eventsWithLazyClose(store: Store, requestId: string, opts: { now?: number } = {}): Promise<EventRow[]> {
  const now = opts.now ?? Date.now();
  const events = await requestEvents(store, requestId);
  const window = windowFromEvents(events);
  if (!window || events.some((event) => event.type === "auction.closed")) return events;
  if (now < Date.parse(window.deadline) + CLOSE_GRACE_MS) return events;
  const posted = events.find((event) => event.type === "request.posted")!;
  const result = computeClose(events, window);
  const ranked = currentOffers(offersFromEvents(events, window.deadline));
  const reference = result.winner ? bestPublic(ranked, result.winner.currency, window.opened_at) : null;
  // The held order comes from the log's own private request.holding event.
  const held = events.find((event) => event.type === "request.holding")?.private ?? null;
  const quantity = Math.max(1, Number(posted.private.quantity ?? 1) || 1);
  const heldUnit =
    held && result.winner && typeof held.price_cents === "number" && String(held.currency).toUpperCase() === result.winner.currency.toUpperCase()
      ? Math.floor(held.price_cents / quantity)
      : null;
  // A private band that is withheld must not be undone by a public "beat the public price" flag.
  const beatPublic = result.band === "withheld" || result.band === "near_public" ? null : result.beat_public;
  const close: NewEvent = {
    id: closedEventId(requestId),
    type: "auction.closed",
    at: window.deadline,
    request_id: requestId,
    store_domain: result.winner?.store_domain ?? null,
    internal: posted.internal || result.test,
    agent_class: posted.agent_class,
    public: {
      winner: result.winner
        ? {
            store: result.winner.store_domain,
            source: result.winner.source,
            confirmed: result.winner.confirmed,
            observed_at: result.winner.observed_at,
          }
        : null,
      result: result.result,
      result_label: result.result === "last_seen" ? RESULT_LAST_SEEN_LABEL : null,
      band: result.band,
      band_label: result.band ? BAND_LABELS[result.band] : null,
      bidders: result.bidders,
      lead_changes: result.lead_changes,
      beat_public: beatPublic,
      closed_lazily_at: new Date(now).toISOString(),
      ...(result.test ? { test: true } : {}),
    },
    private: {
      winner_price_cents: result.winner?.price_cents ?? null,
      winner_currency: result.winner?.currency ?? null,
      winner_product_url: result.winner?.product_url ?? null,
      plain_band: result.plain_band,
      beat_public: result.beat_public,
      gap_to_public_cents: result.winner && reference ? reference.price_cents - result.winner.price_cents : null,
      gap_to_holding_cents: heldUnit != null && result.winner ? heldUnit - result.winner.price_cents : null,
    },
  };
  await store.batch([eventStatement(close, null)]);
  return requestEvents(store, requestId);
}

export type StandingEntry = {
  rank: number;
  store_domain: string;
  source: OfferSource;
  price: string;
  price_cents: number;
  currency: string;
  available: boolean;
  product_url: string;
  band: Band;
  expires_at: string | null;
  observed_at: string | null;
  confirmed: boolean;
  /** Unconfirmed and older than STALE_AFTER_DAYS: shown, but it cannot win while a confirmed offer exists. */
  stale: boolean;
  test: boolean;
};

/** Stores whose snapshot offer was withdrawn after a live read. Public: names and reasons only. */
export function withdrawnStores(events: EventRow[], until?: string): Array<{ store_domain: string; at: string; reason: string }> {
  return events
    .filter((event) => event.type === "offer.withdrawn" && event.store_domain && (!until || event.at <= until))
    .map((event) => ({ store_domain: event.store_domain!, at: event.at, reason: String(event.public.reason ?? "not_found") }));
}

/** The poster's view (with its token): amounts, links, and the winner after close. */
export function posterAuction(events: EventRow[], now = Date.now()) {
  const window = windowFromEvents(events);
  if (!window) return null;
  const closed = events.find((event) => event.type === "auction.closed") ?? null;
  const offers = offersFromEvents(events, closed ? window.deadline : undefined);
  const ranked = standingOrder(currentOffers(offers), window.opened_at);
  const standing: StandingEntry[] = ranked.map((offer, index) => ({
    rank: index + 1,
    store_domain: offer.store_domain,
    source: offer.source,
    price: centsToDecimal(offer.price_cents),
    price_cents: offer.price_cents,
    currency: offer.currency,
    available: offer.available,
    product_url: offer.product_url,
    band: bandFor(offer, ranked, window.opened_at),
    expires_at: offer.expires_at,
    observed_at: offer.observed_at,
    confirmed: offer.confirmed,
    stale: isStale(offer, window.opened_at),
    test: offer.test === true,
  }));
  const secondsLeft = Math.max(0, Math.ceil((Date.parse(window.deadline) - now) / 1000));
  const winnerPublic = closed?.public.winner as { store: string; source: OfferSource } | null | undefined;
  const winner = closed && winnerPublic ? (standing.find((entry) => entry.store_domain === winnerPublic.store) ?? null) : null;
  const kind = (closed?.public.result as ResultKind | undefined) ?? (winner ? (winner.confirmed ? "won" : "last_seen") : "none");
  return {
    status: closed ? ("closed" as const) : secondsLeft > 0 ? ("open" as const) : ("closing" as const),
    opened_at: window.opened_at,
    deadline: window.deadline,
    window_seconds: window.window_seconds,
    seconds_left: secondsLeft,
    lead_changes: events.filter((event) => event.type === "lead.changed" && event.at <= window.deadline).length,
    standing,
    withdrawn: withdrawnStores(events, closed ? window.deadline : undefined),
    winner: winner ? { ...winner, checkout_url: winner.product_url } : null,
    result: closed
      ? {
          kind,
          label: kind === "last_seen" ? RESULT_LAST_SEEN_LABEL : null,
          bidders: Number(closed.public.bidders ?? 0),
          band: (closed.private.plain_band as Band | null | undefined) ?? (closed.public.band as Band | null) ?? null,
          beat_public: closed.private.beat_public === true || closed.public.beat_public === true,
          gap_to_holding_cents: (closed.private.gap_to_holding_cents as number | null) ?? null,
        }
      : null,
  };
}
