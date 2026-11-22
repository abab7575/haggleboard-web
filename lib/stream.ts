import type { Band, OfferSource } from "./auction.js";
import { BAND_LABELS, eventsWithLazyClose, windowFromEvents } from "./auction.js";
import type { Store } from "./db.js";
import type { EventRow } from "./events.js";
import { publicNeed } from "./privacy.js";
import { normalizeStoredNeed } from "../referee/parse.js";
import type { ResolvedNeed } from "../referee/types.js";

/**
 * THE PUBLIC EVENT STREAM for one request. Built field by field from a whitelist: no amount of a
 * private offer or store bid, no held order, no price cap, no text, no caller data. Public prices
 * appear only on store.joined for offers that are themselves public prices.
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
    }
  | { seq: number; type: "lead.changed"; at: string; store: string; source: OfferSource; band: Band; band_label: string }
  | {
      seq: number;
      type: "auction.closed";
      at: string;
      winner: { store: string; source: OfferSource } | null;
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
  events: PublicStreamEvent[];
};

const TYPE_ORDER: Record<string, number> = { "request.posted": 0, "offer.made": 1, "lead.changed": 2, "auction.closed": 3 };

function source(value: unknown): OfferSource {
  return value === "private_offer" || value === "store_bid" ? value : "public_price";
}

function band(value: unknown): Band | null {
  return typeof value === "string" && value in BAND_LABELS ? (value as Band) : null;
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
      if (joined.has(event.store_domain)) continue;
      joined.add(event.store_domain);
      const src = source(event.public.source);
      const isPublic = src === "public_price" && typeof event.public.public_price === "string";
      out.push({
        seq,
        type: "store.joined",
        at: event.at,
        store: event.store_domain,
        source: src,
        public_price: isPublic ? String(event.public.public_price) : null,
        currency: isPublic ? String(event.public.currency ?? "") || null : null,
      });
    } else if (event.type === "lead.changed") {
      const b = band(event.public.band);
      if (!b || !event.store_domain || event.at > window.deadline) continue;
      out.push({ seq, type: "lead.changed", at: event.at, store: event.store_domain, source: source(event.public.source), band: b, band_label: BAND_LABELS[b] });
    } else if (event.type === "auction.closed") {
      const w = event.public.winner as { store?: unknown; source?: unknown } | null;
      const b = band(event.public.band);
      out.push({
        seq,
        type: "auction.closed",
        at: event.at,
        winner: w && typeof w.store === "string" ? { store: w.store, source: source(w.source) } : null,
        band: b,
        band_label: b ? BAND_LABELS[b] : null,
        bidders: Number(event.public.bidders ?? 0),
        lead_changes: Number(event.public.lead_changes ?? 0),
      });
    }
  }
  return out;
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
    events: list,
  };
}
