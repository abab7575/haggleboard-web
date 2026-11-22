import { z } from "zod";

/**
 * The public side of an auction ("arena").
 *
 * Privacy rule: the public sees WHO is bidding, who leads, each lead change,
 * the clock, and a rough band of how far the leader is under the best public
 * price. It never sees an offer amount, the shopper, the shopper's maximum,
 * an order held elsewhere, or any store's floor. Only the posting agent sees
 * amounts, and that view is not rendered by these components.
 *
 * Every event that reaches an arena component must pass through
 * `toPublicArenaEvent`, which keeps only the whitelisted fields below.
 */

export type BidderTone = "clay" | "plum" | "ochre" | "slate";

export type PublicBidder = {
  id: string;
  /** Store display name. Demo scripts use obviously made-up names. */
  name: string;
  /** Colour of the store's token. Purely visual. */
  tone: BidderTone;
  /**
   * Live auctions only: the store's PUBLIC list price, already formatted (for
   * example "$119.95"). Never set for a private offer or a store bid.
   */
  publicPrice?: string;
};

/** Seconds since the clock started. */
type At = { at: number };

export type PublicArenaEvent =
  | (At & { kind: "join"; bidder: string })
  /**
   * `band` is a multiple of 5: "about 10% under the best public price". Live
   * auctions also carry `label`, the engine's own words for the band.
   */
  | (At & { kind: "lead"; bidder: string; band: number; label?: string })
  /**
   * Close of the clock. `saved_pct` is the winner's exact percent under the best
   * public price, which is public at the close in the demo. `revealed_price` is
   * only set when the winning store chose to publish its price.
   *
   * Live auctions publish a band, not an exact percent: they set `label` (such
   * as "5 to 10% under the best public price") and leave `saved_pct` null.
   * `winner` is null when no store had the item in stock.
   */
  | (At & {
      kind: "close";
      winner: string | null;
      saved_pct: number | null;
      won_at: number;
      revealed_price?: string;
      label?: string;
    });

const BAND_STEP = 5;
const BAND_MAX = 40;

/** Round an exact percent to the public band. Never exposes the exact figure. */
export function toBand(pctUnder: number): number {
  if (!Number.isFinite(pctUnder) || pctUnder <= 0) return 0;
  const band = Math.round(pctUnder / BAND_STEP) * BAND_STEP;
  return Math.min(BAND_MAX, Math.max(BAND_STEP, band));
}

const seconds = z.number().finite().min(0).max(24 * 3600);
const id = z.string().min(1).max(64);
const words = z.string().min(1).max(80);

const joinSchema = z.object({ kind: z.literal("join"), at: seconds, bidder: id });
const leadSchema = z.object({
  kind: z.literal("lead"),
  at: seconds,
  bidder: id,
  // A raw event may carry an exact percent; only its band survives.
  band: z.number().optional(),
  pct_under: z.number().optional(),
  label: words.optional(),
});
const closeSchema = z.object({
  kind: z.literal("close"),
  at: seconds,
  winner: id.nullable(),
  saved_pct: z.number().min(0).max(100).nullable(),
  won_at: seconds,
  revealed_price: z.string().max(32).optional(),
  store_chose_to_reveal: z.boolean().optional(),
  label: words.optional(),
});

/**
 * Whitelist a raw auction event into its public form. Unknown fields such as
 * `amount_cents`, `max_price`, `floor_cents`, `shopper` or `held_order` are
 * dropped. A revealed price survives only when the store explicitly chose to
 * reveal it. Returns null for anything that is not a public event.
 */
export function toPublicArenaEvent(raw: unknown): PublicArenaEvent | null {
  const kind = (raw as { kind?: unknown } | null)?.kind;
  if (kind === "join") {
    const parsed = joinSchema.safeParse(raw);
    return parsed.success ? { kind: "join", at: parsed.data.at, bidder: parsed.data.bidder } : null;
  }
  if (kind === "lead") {
    const parsed = leadSchema.safeParse(raw);
    if (!parsed.success) return null;
    const source = parsed.data.pct_under ?? parsed.data.band ?? 0;
    const out: PublicArenaEvent = { kind: "lead", at: parsed.data.at, bidder: parsed.data.bidder, band: toBand(source) };
    if (parsed.data.label) out.label = parsed.data.label;
    return out;
  }
  if (kind === "close") {
    const parsed = closeSchema.safeParse(raw);
    if (!parsed.success) return null;
    const { at, winner, saved_pct, won_at, revealed_price, store_chose_to_reveal, label } = parsed.data;
    const out: PublicArenaEvent = {
      kind: "close",
      at,
      winner,
      saved_pct: saved_pct == null ? null : Math.round(saved_pct),
      won_at,
    };
    if (store_chose_to_reveal === true && revealed_price) out.revealed_price = revealed_price;
    if (label) out.label = label;
    return out;
  }
  return null;
}

export function toPublicArenaEvents(raw: unknown[]): PublicArenaEvent[] {
  return raw
    .map(toPublicArenaEvent)
    .filter((e): e is PublicArenaEvent => e !== null)
    .sort((a, b) => a.at - b.at);
}

export type BidderState = {
  bidder: PublicBidder;
  joined: boolean;
  band: number | null;
  /** The engine's words for this store's band, when the event carried them. */
  label: string | null;
  leading: boolean;
  /** Number of times this store has taken the lead so far. */
  leads: number;
};

export type CommentaryLine = { at: number; text: string; tone: "info" | "lead" | "snipe" | "close" };

export type ArenaState = {
  t: number;
  remaining: number;
  phase: "open" | "final" | "closed";
  leaderId: string | null;
  leaderBand: number | null;
  bidders: BidderState[];
  commentary: CommentaryLine[];
  leadChanges: number;
  close: Extract<PublicArenaEvent, { kind: "close" }> | null;
  /** Bumps on every lead change; lets the UI replay the stamp animation. */
  leadKey: number;
};

export const FINAL_SECONDS = 15;

export function bandLabel(band: number | null): string {
  if (band == null || band <= 0) return "at the public price";
  return `about ${band}% under`;
}

/** What a lane or a commentary line says about a band: the event's own words first. */
export function bandText(band: number | null, label?: string | null): string {
  return label ?? bandLabel(band);
}

/** How a close reads: the exact percent in the demo, the band's words in a live auction. */
export function savedText(close: { saved_pct: number | null; label?: string }): string {
  if (close.label) return close.label;
  return `${close.saved_pct ?? 0}% under the best public price`;
}

export function clockLabel(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function durationWords(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  const parts: string[] = [];
  if (m > 0) parts.push(`${m} minute${m === 1 ? "" : "s"}`);
  if (r > 0 || m === 0) parts.push(`${r} second${r === 1 ? "" : "s"}`);
  return parts.join(" ");
}

export function commentaryFor(
  event: PublicArenaEvent,
  bidders: PublicBidder[],
  durationSec: number,
  leaderBefore: string | null,
): CommentaryLine {
  const name = (bidderId: string) => bidders.find((b) => b.id === bidderId)?.name ?? "A store";
  if (event.kind === "join") {
    const price = bidders.find((b) => b.id === event.bidder)?.publicPrice;
    return { at: event.at, text: `${name(event.bidder)} is in${price ? `, public price ${price}` : ""}.`, tone: "info" };
  }
  if (event.kind === "lead") {
    const left = durationSec - event.at;
    const who = name(event.bidder);
    const band = bandText(event.band, event.label);
    if (leaderBefore == null) return { at: event.at, text: `${who} opens, ${band}.`, tone: "lead" };
    if (left <= FINAL_SECONDS) {
      const n = Math.max(1, Math.round(left));
      const text =
        n <= 3
          ? `${who} snatches it with ${n} second${n === 1 ? "" : "s"} left!`
          : Math.round(event.at) % 2 === 0
            ? `${who} hits back. ${n} seconds left!`
            : `${who} grabs the lead. ${n} seconds to go!`;
      return { at: event.at, text, tone: "snipe" };
    }
    if (leaderBefore === event.bidder) return { at: event.at, text: `${who} goes lower, ${band}.`, tone: "lead" };
    return { at: event.at, text: `${who} takes the lead, ${band}.`, tone: "lead" };
  }
  if (event.winner == null) return { at: event.at, text: "Clock's out. No store had it in stock.", tone: "close" };
  return {
    at: event.at,
    text: `Clock's out. ${name(event.winner)} wins, ${savedText(event)}.`,
    tone: "close",
  };
}

/**
 * Lane order on the board: the leader on top, then the deepest public band,
 * then stores that are in, then empty seats. Ties keep the bidder list order.
 */
export function rankBidders(bidders: BidderState[]): BidderState[] {
  return bidders
    .map((b, i) => ({ b, i }))
    .sort((x, y) => {
      if (x.b.leading !== y.b.leading) return x.b.leading ? -1 : 1;
      const bx = x.b.band ?? -1;
      const by = y.b.band ?? -1;
      if (bx !== by) return by - bx;
      if (x.b.joined !== y.b.joined) return x.b.joined ? -1 : 1;
      return x.i - y.i;
    })
    .map(({ b }) => b);
}

/** Everything the public can see at `t` seconds after the clock started. */
export function arenaStateAt(
  events: PublicArenaEvent[],
  bidders: PublicBidder[],
  durationSec: number,
  t: number,
): ArenaState {
  const states = new Map<string, BidderState>(
    bidders.map((b) => [b.id, { bidder: b, joined: false, band: null, label: null, leading: false, leads: 0 }]),
  );
  let leaderId: string | null = null;
  let leaderBand: number | null = null;
  let leadChanges = 0;
  let leadKey = 0;
  let close: ArenaState["close"] = null;
  const commentary: CommentaryLine[] = [];

  for (const event of events) {
    if (event.at > t) break;
    commentary.push(commentaryFor(event, bidders, durationSec, leaderId));
    if (event.kind === "join") {
      const s = states.get(event.bidder);
      if (s) s.joined = true;
    } else if (event.kind === "lead") {
      const s = states.get(event.bidder);
      if (!s) continue;
      s.joined = true;
      s.band = event.band;
      s.label = event.label ?? null;
      if (leaderId !== event.bidder) {
        if (leaderId != null) leadChanges += 1;
        s.leads += 1;
      }
      leaderId = event.bidder;
      leaderBand = event.band;
      leadKey += 1;
    } else {
      close = event;
      leaderId = event.winner;
    }
  }

  for (const s of states.values()) s.leading = leaderId != null && s.bidder.id === leaderId;
  const remaining = close ? 0 : Math.max(0, durationSec - t);
  const phase = close ? "closed" : remaining <= FINAL_SECONDS ? "final" : "open";
  return {
    t,
    remaining,
    phase,
    leaderId,
    leaderBand,
    bidders: [...states.values()],
    commentary,
    leadChanges,
    close,
    leadKey,
  };
}

/**
 * The share line on a result card. The demo passes an exact percent; a live
 * auction passes the band's words (`label`), because only the band is public.
 */
export function resultLine(
  savedPct: number | null,
  wonAtSec: number,
  perspective: "shopper" | "public",
  winnerName?: string,
  label?: string,
) {
  const time = durationWords(wonAtSec);
  if (label) {
    return perspective === "shopper"
      ? `My agent ran a HaggleBoard auction: ${winnerName ?? "a store"} won, ${label}.`
      : `${winnerName ?? "A store"} won, ${label}.`;
  }
  const how = `${savedPct ?? 0}% under the best public price`;
  return perspective === "shopper" ? `My agent got ${how} in ${time}.` : `${winnerName ?? "A store"} won, ${how}, in ${time}.`;
}

/**
 * Field names that must never appear in public arena markup. Tests render every
 * arena component and check the output against this list.
 */
export const PRIVATE_FIELD_NAMES = [
  "amount_cents",
  "offer_amount",
  "price_cents",
  "max_price",
  "floor_cents",
  "store_floor",
  "shopper_id",
  "shopper_email",
  "held_order",
  "delete_token",
  "pct_under",
] as const;

/** Matches a money amount such as $129, £80.00 or 99 EUR. */
export const MONEY_PATTERN = /[$£€¥]\s?\d|\d\s?(USD|GBP|EUR|CAD|SGD)\b/;
