import type { Band, OfferSource, ResultKind } from "./auction.js";
import { BAND_LABELS, eventsWithLazyClose, RESULT_LAST_SEEN_LABEL, windowFromEvents } from "./auction.js";
import type { Store } from "./db.js";
import type { EventRow } from "./events.js";
import { publicNeed } from "./privacy.js";
import { normalizeStoredNeed } from "../referee/parse.js";
import type { ResolvedNeed } from "../referee/types.js";

/**
 * THE PUBLIC EVENT STREAM for one request. Built field by field from a whitelist: no amount of a
 * private offer or store bid, no held order, no price cap, no text, no caller data. Public prices
 * appear only on store.joined and price.confirmed for offers that are themselves public prices.
 *
 * These are the shapes the arena UI reads: props { requestLabel, deadline, events[] }.
 */
export type PublicStreamEvent =
  | { seq: number; type: "auction.opened"; at: string; deadline: string; window_seconds: number }
  | {
      seq: number;
      type: "store.joined";
      at: string;
      store: string;
      source: OfferSource;
      /** Only when source is public_price. Never for a private offer or a store bid. */
      public_price: string | null;
      currency: string | null;
      /** When the price was observed (a snapshot keeps its crawl date). */
      observed_at: string | null;
      /** True when read or made live during this auction. */
      confirmed: boolean;
      /** Unconfirmed and older than the staleness limit: "last seen <date>, not confirmed". */
      stale: boolean;
      /** A fictional test store (TEST_STORES=1 only). */
      test: boolean;
    }
  | {
      seq: number;
      type: "price.confirmed";
      at: string;
      store: string;
      public_price: string;
      currency: string | null;
      observed_at: string;
    }
  | { seq: number; type: "store.withdrawn"; at: string; store: string; reason: string; label: string }
  | { seq: number; type: "lead.changed"; at: string; store: string; source: OfferSource; band: Band; band_label: string }
  | {
      seq: number;
      type: "auction.closed";
      at: string;
      winner: { store: string; source: OfferSource; confirmed: boolean; observed_at: string | null } | null;
      /** won: the winner was confirmed live. last_seen: the best offer left was never confirmed today. */
      result: ResultKind;
      result_label: string | null;
      band: Band | null;
      band_label: string | null;
      bidders: number;
      lead_changes: number;
    };

export type PublicStream = {
  request_id: string;
  requestLabel: string;
  deadline: string | null;
  window_seconds: number | null;
  seconds_left: number;
  status: "open" | "closing" | "closed" | "no_auction";
  now: string;
  /** True when a fictional test store took part (TEST_STORES=1 only). The arena labels it. */
  test_stores: boolean;
  events: PublicStreamEvent[];
};

const TYPE_ORDER: Record<string, number> = {
  "request.posted": 0,
  "offer.made": 1,
  "offer.withdrawn": 2,
  "lead.changed": 3,
  "auction.closed": 4,
};

function source(value: unknown): OfferSource {
  return value === "private_offer" || value === "store_bid" ? value : "public_price";
}

function band(value: unknown): Band | null {
  return typeof value === "string" && value in BAND_LABELS ? (value as Band) : null;
}

function iso(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

export function toPublicEvents(events: EventRow[]): PublicStreamEvent[] {
  const window = windowFromEvents(events);
  if (!window) return [];
  const sorted = [...events].sort(
    (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) || (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) || a.id.localeCompare(b.id),
  );
  const joined = new Set<string>();
  const out: PublicStreamEvent[] = [];
  for (const event of sorted) {
    const seq = out.length + 1;
    if (event.type === "request.posted") {
      out.push({ seq, type: "auction.opened", at: event.at, deadline: window.deadline, window_seconds: window.window_seconds });
    } else if (event.type === "offer.made") {
      if (event.public.after_close === true || event.at > window.deadline || !event.store_domain) continue;
      const src = source(event.public.source);
      const isPublic = src === "public_price" && typeof event.public.public_price === "string";
      const via = String(event.public.via ?? "");
      const confirmed =
        typeof event.public.confirmed === "boolean" ? event.public.confirmed : !(src === "public_price" && via === "snapshot");
      const observed = iso(event.public.observed_at) ?? (confirmed ? event.at : null);
      if (joined.has(event.store_domain)) {
        // A store already in: a live read of its public price confirms (and dates) the price.
        if (isPublic && confirmed && observed) {
          out.push({
            seq,
            type: "price.confirmed",
            at: event.at,
            store: event.store_domain,
            public_price: String(event.public.public_price),
            currency: String(event.public.currency ?? "") || null,
            observed_at: observed,
          });
        }
        continue;
      }
      joined.add(event.store_domain);
      out.push({
        seq,
        type: "store.joined",
        at: event.at,
        store: event.store_domain,
        source: src,
        public_price: isPublic ? String(event.public.public_price) : null,
        currency: isPublic ? String(event.public.currency ?? "") || null : null,
        observed_at: isPublic ? observed : null,
        confirmed,
        stale: event.public.stale === true,
        test: event.public.test === true,
      });
    } else if (event.type === "offer.withdrawn") {
      if (!event.store_domain || event.at > window.deadline) continue;
      out.push({
        seq,
        type: "store.withdrawn",
        at: event.at,
        store: event.store_domain,
        reason: event.public.reason === "out_of_stock" ? "out_of_stock" : "not_found",
        label: "no longer listed",
      });
    } else if (event.type === "lead.changed") {
      const b = band(event.public.band);
      if (!b || !event.store_domain || event.at > window.deadline) continue;
      out.push({ seq, type: "lead.changed", at: event.at, store: event.store_domain, source: source(event.public.source), band: b, band_label: BAND_LABELS[b] });
    } else if (event.type === "auction.closed") {
      const w = event.public.winner as { store?: unknown; source?: unknown; confirmed?: unknown; observed_at?: unknown } | null;
      const b = band(event.public.band);
      const winner =
        w && typeof w.store === "string"
          ? { store: w.store, source: source(w.source), confirmed: w.confirmed !== false, observed_at: iso(w.observed_at) }
          : null;
      const result: ResultKind =
        event.public.result === "won" || event.public.result === "last_seen" || event.public.result === "none"
          ? event.public.result
          : winner
            ? "won"
            : "none";
      out.push({
        seq,
        type: "auction.closed",
        at: event.at,
        winner,
        result,
        result_label: result === "last_seen" ? RESULT_LAST_SEEN_LABEL : null,
        band: b,
        band_label: b ? BAND_LABELS[b] : null,
        bidders: Number(event.public.bidders ?? 0),
        lead_changes: Number(event.public.lead_changes ?? 0),
      });
    }
  }
  return out;
}

/**
 * Who is in the standing, from the public feed: every store that joined and was not withdrawn,
 * split into real and test stores. Pages, titles and the board count from this, so they agree.
 */
export function standingCounts(events: PublicStreamEvent[]): { stores: number; real: number; test: number } {
  const joined = new Map<string, boolean>();
  for (const event of events) if (event.type === "store.joined") joined.set(event.store, event.test);
  for (const event of events) if (event.type === "store.withdrawn") joined.delete(event.store);
  const test = [...joined.values()].filter(Boolean).length;
  return { stores: joined.size, real: joined.size - test, test };
}

/** The words for that count: "3 stores answered", "Test stores only", "Test stores and 1 real store". */
export function standingWords(counts: { stores: number; real: number; test: number }): string {
  if (counts.test > 0 && counts.real === 0) return "Test stores only";
  if (counts.test > 0) return `Test stores and ${counts.real} real store${counts.real === 1 ? "" : "s"}`;
  return `${counts.stores} store${counts.stores === 1 ? "" : "s"} answered`;
}

export function hasTestStores(events: EventRow[]): boolean {
  return events.some((event) => event.public.test === true);
}

export async function publicStream(store: Store, requestId: string, now = Date.now()): Promise<PublicStream | null> {
  const row = await store.getRequest(requestId);
  if (!row) return null;
  const need = normalizeStoredNeed(JSON.parse(row.need_json) as Partial<ResolvedNeed>);
  const events = await eventsWithLazyClose(store, requestId, { now });
  const window = windowFromEvents(events);
  const list = toPublicEvents(events);
  const closed = list.some((event) => event.type === "auction.closed");
  const secondsLeft = window ? Math.max(0, Math.ceil((Date.parse(window.deadline) - now) / 1000)) : 0;
  return {
    request_id: requestId,
    requestLabel: publicNeed(need).label,
    deadline: window?.deadline ?? null,
    window_seconds: window?.window_seconds ?? null,
    seconds_left: secondsLeft,
    status: !window ? "no_auction" : closed ? "closed" : secondsLeft > 0 ? "open" : "closing",
    now: new Date(now).toISOString(),
    test_stores: hasTestStores(events),
    events: list,
  };
}
