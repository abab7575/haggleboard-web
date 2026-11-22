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
 */
export const AUCTION_DEFAULT_SECONDS = 120;
export const AUCTION_MIN_SECONDS = 30;
export const AUCTION_MAX_SECONDS = 600;
/** A short grace so an offer stamped just before the deadline but committed just after still counts. */
export const CLOSE_GRACE_MS = 2_000;

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
};

export type IncomingOffer = Omit<AuctionOffer, "event_id" | "at"> & {
  delivery_days?: number | null;
  returns_days?: number | null;
};

export type Band =
  | "no_public_price"
  | "not_compared"
  | "above_public"
  | "at_public"
  | "under_0_5"
  | "under_5_10"
  | "under_10_20"
  | "under_20_plus";

export const BAND_LABELS: Record<Band, string> = {
  no_public_price: "no public price to compare with",
  not_compared: "different currency from the best public price",
  above_public: "above the best public price",
  at_public: "at the best public price",
  under_0_5: "up to 5% under the best public price",
  under_5_10: "5 to 10% under the best public price",
  under_10_20: "10 to 20% under the best public price",
  under_20_plus: "more than 20% under the best public price",
};

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
  return {
    event_id: event.id,
    at: event.at,
    store_domain: event.store_domain,
    source,
    via: String(event.public.via ?? ""),
    price_cents: cents,
    currency: String(event.public.currency ?? ""),
    available: event.public.available !== false,
    product_url: String(event.private.product_url ?? event.public.product_url ?? ""),
    title: event.private.title == null ? null : String(event.private.title),
    expires_at: event.private.expires_at == null ? null : String(event.private.expires_at),
  };
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
 * lowest price, then who offered first, then store name. Nothing can pay to move up.
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
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    return a.store_domain.localeCompare(b.store_domain);
  });
}

export function bestPublic(offers: AuctionOffer[], currency: string): AuctionOffer | null {
  return (
    rankAuction(offers.filter((offer) => offer.source === "public_price" && offer.available && offer.currency === currency))[0] ??
    null
  );
}

/** How far an offer is under the best public price in its currency, as a coarse band. */
export function bandFor(offer: AuctionOffer, offers: AuctionOffer[]): Band {
  const reference = bestPublic(offers, offer.currency);
  if (!reference) {
    return offers.some((item) => item.source === "public_price" && item.available) ? "not_compared" : "no_public_price";
  }
  const gap = (reference.price_cents - offer.price_cents) / reference.price_cents;
  if (gap < 0) return "above_public";
  if (gap === 0) return "at_public";
  if (gap <= 0.05) return "under_0_5";
  if (gap <= 0.1) return "under_5_10";
  if (gap <= 0.2) return "under_10_20";
  return "under_20_plus";
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
  for (const [index, item] of incoming.entries()) {
    // One millisecond apart, so offers written together keep their order in the log and the stream.
    const at = new Date(now + index).toISOString();
    const id = randomUUID();
    const offer: AuctionOffer = { ...item, event_id: id, at };
    const afterClose = window ? at > window.deadline : true;
    const isPublic = item.source === "public_price";
    events.push({
      id,
      type: "offer.made",
      at,
      request_id: requestId,
      store_domain: item.store_domain,
      public: {
        source: item.source,
        via: item.via,
        currency: item.currency,
        available: item.available,
        public_price: isPublic ? centsToDecimal(item.price_cents) : null,
        product_url: isPublic ? item.product_url : null,
        delivery_days: item.delivery_days ?? null,
        returns_days: item.returns_days ?? null,
        round: 1,
        since_post_ms: window ? Math.max(0, now - Date.parse(window.opened_at)) : null,
        after_close: afterClose,
      },
      private: {
        price_cents: item.price_cents,
        price: centsToDecimal(item.price_cents),
        product_url: item.product_url,
        title: item.title,
        expires_at: item.expires_at,
      },
    });
    if (afterClose || !window) continue;
    const before = currentOffers(known)[0] ?? null;
    known.push(offer);
    const ranked = currentOffers(known);
    const after = ranked[0] ?? null;
    if (after && (!before || before.store_domain !== after.store_domain || before.source !== after.source)) {
      const band = bandFor(after, ranked);
      events.push({
        type: "lead.changed",
        at,
        request_id: requestId,
        store_domain: after.store_domain,
        public: { store: after.store_domain, source: after.source, band, band_label: BAND_LABELS[band], previous_store: before?.store_domain ?? null },
        private: { price_cents: after.price_cents, currency: after.currency },
      });
    }
  }
  return { events, offers: known };
}

/** Prior offers for a request, from its log. */
export function offersFromEvents(events: EventRow[], until?: string): AuctionOffer[] {
  return events
    .filter((event) => event.type === "offer.made" && event.public.after_close !== true && (!until || event.at <= until))
    .map(offerFromEvent)
    .filter((offer): offer is AuctionOffer => offer !== null);
}

export type ClosedResult = {
  winner: AuctionOffer | null;
  band: Band | null;
  bidders: number;
  lead_changes: number;
  beat_public: boolean;
};

export function computeClose(events: EventRow[], window: AuctionWindow): ClosedResult {
  const offers = offersFromEvents(events, window.deadline);
  const ranked = currentOffers(offers);
  const winner = ranked.find((offer) => offer.available) ?? null;
  const band = winner ? bandFor(winner, ranked) : null;
  return {
    winner,
    band,
    bidders: new Set(offers.map((offer) => offer.store_domain)).size,
    lead_changes: events.filter((event) => event.type === "lead.changed" && event.at <= window.deadline).length,
    beat_public: band != null && band.startsWith("under_") && winner?.source !== "public_price",
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
  const reference = result.winner ? bestPublic(ranked, result.winner.currency) : null;
  // The held order comes from the log's own private request.holding event.
  const held = events.find((event) => event.type === "request.holding")?.private ?? null;
  const quantity = Math.max(1, Number(posted.private.quantity ?? 1) || 1);
  const heldUnit =
    held && result.winner && typeof held.price_cents === "number" && String(held.currency).toUpperCase() === result.winner.currency.toUpperCase()
      ? Math.floor(held.price_cents / quantity)
      : null;
  const close: NewEvent = {
    id: closedEventId(requestId),
    type: "auction.closed",
    at: window.deadline,
    request_id: requestId,
    store_domain: result.winner?.store_domain ?? null,
    internal: posted.internal,
    agent_class: posted.agent_class,
    public: {
      winner: result.winner ? { store: result.winner.store_domain, source: result.winner.source } : null,
      band: result.band,
      band_label: result.band ? BAND_LABELS[result.band] : null,
      bidders: result.bidders,
      lead_changes: result.lead_changes,
      beat_public: result.beat_public,
      closed_lazily_at: new Date(now).toISOString(),
    },
    private: {
      winner_price_cents: result.winner?.price_cents ?? null,
      winner_currency: result.winner?.currency ?? null,
      winner_product_url: result.winner?.product_url ?? null,
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
};

/** The poster's view (with its token): amounts, links, and the winner after close. */
export function posterAuction(events: EventRow[], now = Date.now()) {
  const window = windowFromEvents(events);
  if (!window) return null;
  const closed = events.find((event) => event.type === "auction.closed") ?? null;
  const offers = offersFromEvents(events, closed ? window.deadline : undefined);
  const ranked = currentOffers(offers);
  const standing: StandingEntry[] = ranked.map((offer, index) => ({
    rank: index + 1,
    store_domain: offer.store_domain,
    source: offer.source,
    price: centsToDecimal(offer.price_cents),
    price_cents: offer.price_cents,
    currency: offer.currency,
    available: offer.available,
    product_url: offer.product_url,
    band: bandFor(offer, ranked),
    expires_at: offer.expires_at,
  }));
  const secondsLeft = Math.max(0, Math.ceil((Date.parse(window.deadline) - now) / 1000));
  const winnerPublic = closed?.public.winner as { store: string; source: OfferSource } | null | undefined;
  const winner = closed && winnerPublic ? (standing.find((entry) => entry.store_domain === winnerPublic.store) ?? null) : null;
  return {
    status: closed ? ("closed" as const) : secondsLeft > 0 ? ("open" as const) : ("closing" as const),
    opened_at: window.opened_at,
    deadline: window.deadline,
    window_seconds: window.window_seconds,
    seconds_left: secondsLeft,
    lead_changes: events.filter((event) => event.type === "lead.changed" && event.at <= window.deadline).length,
    standing,
    winner: winner ? { ...winner, checkout_url: winner.product_url } : null,
    result: closed
      ? {
          bidders: Number(closed.public.bidders ?? 0),
          band: (closed.public.band as Band | null) ?? null,
          beat_public: closed.public.beat_public === true,
          gap_to_holding_cents: (closed.private.gap_to_holding_cents as number | null) ?? null,
        }
      : null,
  };
}
