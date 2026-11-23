import type { BidderTone, PublicArenaEvent, PublicBidder } from "./arena";
import { toPublicArenaEvents } from "./arena";
import type { PublicStream, PublicStreamEvent } from "./stream";

/**
 * THE ADAPTER from the engine's public auction feed (GET /api/requests/{id}/events and the SSE
 * stream, shapes in lib/stream.ts) to the arena's event format (lib/arena.ts).
 *
 * The feed is already public. This adapter keeps it that way: it reads only the whitelisted feed
 * fields, a store's public list price only when the feed marks the offer as a public price, and
 * every event goes through toPublicArenaEvents before it reaches a component. Private offers show
 * a band, never an amount.
 */

type Band = Extract<PublicStreamEvent, { type: "lead.changed" }>["band"];

/** Where a band puts a store's token on the track (0 = the best public price, 20 = 20% or more under). */
export const BAND_POSITION: Record<Band, number> = {
  no_public_price: 0,
  not_compared: 0,
  above_public: 0,
  at_public: 0,
  under_0_5: 5,
  under_5_10: 10,
  under_10_20: 15,
  under_20_plus: 20,
  near_public: 0,
  withheld: 0,
};

/** Short words for a lane. The close keeps the engine's full band label. */
export const BAND_SHORT: Record<Band, string> = {
  no_public_price: "no public price to compare",
  not_compared: "other currency",
  above_public: "above the best public price",
  at_public: "at the best public price",
  under_0_5: "up to 5% under",
  under_5_10: "5 to 10% under",
  under_10_20: "10 to 20% under",
  under_20_plus: "more than 20% under",
  near_public: "within 5% of the best public price",
  withheld: "private offer",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "18 Oct" from an ISO time (UTC). */
export function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** What a public price's date says: "confirmed today", "last seen 18 Oct, not confirmed", "seen 20 Nov". */
export function priceNote(input: { confirmed: boolean; stale: boolean; observed_at: string | null }): string {
  if (input.confirmed) return "confirmed today";
  const date = shortDate(input.observed_at);
  if (input.stale) return date ? `last seen ${date}, not confirmed` : "date unknown, not confirmed";
  return date ? `seen ${date}, not confirmed today` : "not confirmed today";
}

const TONES: BidderTone[] = ["clay", "plum", "ochre", "slate"];

export function storeName(domain: string): string {
  return domain.replace(/^www\./i, "");
}

/** "119.95" + "USD" becomes "$119.95". Unknown or missing currency keeps the number and code. */
export function formatPublicPrice(price: string | null, currency: string | null): string | undefined {
  if (!price) return undefined;
  const amount = Number(price);
  if (!Number.isFinite(amount)) return undefined;
  const code = (currency ?? "").toUpperCase();
  if (/^[A-Z]{3}$/.test(code) && code !== "UNK") {
    try {
      return new Intl.NumberFormat("en", { style: "currency", currency: code }).format(amount);
    } catch {
      return `${price} ${code}`;
    }
  }
  return price;
}

export type LiveResult = {
  /** Store domain of the winner, or null when no store had it in stock. */
  winner: string | null;
  winnerName: string | null;
  band: Band | null;
  /** The engine's band label, for example "5 to 10% under the best public price". */
  label: string | null;
  /** Seconds after the clock opened that the winning offer took first place. */
  wonAtSec: number;
  bidders: number;
  leadChanges: number;
  /** How the winner won: its public price, a private offer, or a keyed store bid. */
  winnerSource: "public_price" | "private_offer" | "store_bid" | null;
  /** won: confirmed live. last_seen: the best offer left was never confirmed today. */
  kind: "won" | "last_seen" | "none";
  /** "Best last-seen price, not confirmed today" for last_seen. */
  kindLabel: string | null;
  /** The winner's price date, in words ("confirmed today", "last seen 18 Oct, not confirmed"). */
  winnerPriceNote: string | null;
};

export type LiveArenaData = {
  request: string;
  status: PublicStream["status"];
  /** ISO time the clock opened (deadline minus the window), or null for a request with no auction. */
  opensAt: string | null;
  deadline: string | null;
  durationSec: number;
  bidders: PublicBidder[];
  events: PublicArenaEvent[];
  /** Number of stores that answered so far. */
  joined: number;
  /** True when a fictional test store is in this auction (TEST_STORES=1 only). */
  testStores: boolean;
  result: LiveResult | null;
};

type FeedLike = Pick<PublicStream, "requestLabel" | "deadline" | "window_seconds" | "status" | "events">;

/** Map the public feed to the arena's props. Pure: same feed in, same arena out. */
export function feedToArena(feed: FeedLike): LiveArenaData {
  const durationSec = feed.window_seconds ?? 120;
  const deadlineMs = feed.deadline ? Date.parse(feed.deadline) : NaN;
  const openedMs = Number.isFinite(deadlineMs) ? deadlineMs - durationSec * 1000 : NaN;
  const opensAt = Number.isFinite(openedMs) ? new Date(openedMs).toISOString() : null;
  const at = (iso: string) => {
    if (!Number.isFinite(openedMs)) return 0;
    const sec = (Date.parse(iso) - openedMs) / 1000;
    return Math.min(durationSec, Math.max(0, Math.round(sec * 10) / 10));
  };

  const bidders: PublicBidder[] = [];
  const ids = new Map<string, string>();
  const bidderFor = (domain: string, publicPrice?: string) => {
    const id = domain.slice(0, 64);
    if (!ids.has(domain)) {
      ids.set(domain, id);
      bidders.push({
        id,
        name: storeName(domain),
        tone: TONES[bidders.length % TONES.length]!,
        ...(publicPrice ? { publicPrice } : {}),
      });
    }
    return id;
  };

  const raw: unknown[] = [];
  const lastLeadAt = new Map<string, number>();
  const joinedAt = new Map<string, number>();
  const notes = new Map<string, string>();
  let testStores = false;
  let result: LiveResult | null = null;
  const sorted = [...feed.events].sort((a, b) => a.seq - b.seq);
  for (const event of sorted) {
    if (event.type === "store.joined") {
      const price = event.source === "public_price" ? formatPublicPrice(event.public_price, event.currency) : undefined;
      const bidder = bidderFor(event.store, price);
      const entry = bidders.find((b) => b.id === bidder)!;
      if (event.test) {
        entry.test = true;
        testStores = true;
      }
      if (price) {
        const note = priceNote(event);
        entry.priceNote = note;
        notes.set(bidder, note);
      }
      joinedAt.set(bidder, at(event.at));
      raw.push({ kind: "join", at: at(event.at), bidder });
    } else if (event.type === "price.confirmed") {
      const bidder = bidderFor(event.store);
      const entry = bidders.find((b) => b.id === bidder)!;
      const price = formatPublicPrice(event.public_price, event.currency);
      if (price) entry.publicPrice = price;
      entry.priceNote = "confirmed today";
      notes.set(bidder, "confirmed today");
    } else if (event.type === "store.withdrawn") {
      const bidder = bidderFor(event.store);
      const entry = bidders.find((b) => b.id === bidder)!;
      entry.priceNote = "no longer listed";
      notes.set(bidder, "no longer listed");
      raw.push({ kind: "withdraw", at: at(event.at), bidder });
    } else if (event.type === "lead.changed") {
      const bidder = bidderFor(event.store);
      const when = at(event.at);
      lastLeadAt.set(bidder, when);
      raw.push({
        kind: "lead",
        at: when,
        bidder,
        band: BAND_POSITION[event.band] ?? 0,
        label: BAND_SHORT[event.band],
        ...(event.source !== "public_price" ? { private: true } : {}),
      });
    } else if (event.type === "auction.closed") {
      const winner = event.winner ? bidderFor(event.winner.store) : null;
      const wonAtSec = winner ? (lastLeadAt.get(winner) ?? joinedAt.get(winner) ?? 0) : 0;
      result = {
        winner,
        winnerName: event.winner ? storeName(event.winner.store) : null,
        band: event.band,
        label: event.band_label,
        wonAtSec,
        bidders: event.bidders,
        leadChanges: event.lead_changes,
        kind: event.result,
        winnerSource: event.winner?.source ?? null,
        kindLabel: event.result_label,
        winnerPriceNote:
          event.winner && event.winner.source === "public_price"
            ? priceNote({
                confirmed: event.winner.confirmed,
                stale: event.result === "last_seen",
                observed_at: event.winner.observed_at,
              })
            : null,
      };
      raw.push({
        kind: "close",
        at: durationSec,
        winner,
        saved_pct: null,
        won_at: wonAtSec,
        ...(event.result === "last_seen" ? { result: "last_seen", label: event.result_label ?? "not confirmed today" } : {}),
        ...(event.result !== "last_seen" && event.band_label ? { label: event.band_label } : {}),
      });
    }
  }

  return {
    request: feed.requestLabel,
    status: feed.status,
    opensAt,
    deadline: feed.deadline,
    durationSec,
    bidders,
    events: toPublicArenaEvents(raw),
    joined: joinedAt.size,
    testStores,
    result,
  };
}

/** Merge newly received feed events into a list, by seq, without duplicates. */
export function mergeFeedEvents(current: PublicStreamEvent[], incoming: PublicStreamEvent[]): PublicStreamEvent[] {
  const seen = new Set(current.map((event) => event.seq));
  const added = incoming.filter((event) => !seen.has(event.seq));
  if (added.length === 0) return current;
  return [...current, ...added].sort((a, b) => a.seq - b.seq);
}
