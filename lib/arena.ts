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
};

/** Seconds since the clock started. */
type At = { at: number };

export type PublicArenaEvent =
  | (At & { kind: "join"; bidder: string })
  /** `band` is a multiple of 5: "about 10% under the best public price". */
  | (At & { kind: "lead"; bidder: string; band: number })
  /**
   * Close of the clock. `saved_pct` is the winner's exact percent under the best
   * public price, which is public at the close. `revealed_price` is only set
   * when the winning store chose to publish its price.
   */
  | (At & { kind: "close"; winner: string; saved_pct: number; won_at: number; revealed_price?: string });

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

const joinSchema = z.object({ kind: z.literal("join"), at: seconds, bidder: id });
const leadSchema = z.object({
  kind: z.literal("lead"),
  at: seconds,
  bidder: id,
  // A raw event may carry an exact percent; only its band survives.
  band: z.number().optional(),
  pct_under: z.number().optional(),
});
const closeSchema = z.object({
  kind: z.literal("close"),
  at: seconds,
  winner: id,
  saved_pct: z.number().min(0).max(100),
  won_at: seconds,
  revealed_price: z.string().max(32).optional(),
  store_chose_to_reveal: z.boolean().optional(),
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
    return { kind: "lead", at: parsed.data.at, bidder: parsed.data.bidder, band: toBand(source) };
  }
  if (kind === "close") {
    const parsed = closeSchema.safeParse(raw);
    if (!parsed.success) return null;
    const { at, winner, saved_pct, won_at, revealed_price, store_chose_to_reveal } = parsed.data;
    const out: PublicArenaEvent = { kind: "close", at, winner, saved_pct: Math.round(saved_pct), won_at };
    if (store_chose_to_reveal === true && revealed_price) out.revealed_price = revealed_price;
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

export const FINAL_SECONDS = 10;

export function bandLabel(band: number | null): string {
  if (band == null || band <= 0) return "at the public price";
  return `about ${band}% under`;
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
  if (event.kind === "join") return { at: event.at, text: `${name(event.bidder)} is in.`, tone: "info" };
  if (event.kind === "lead") {
    const left = durationSec - event.at;
    const who = name(event.bidder);
    if (leaderBefore == null) return { at: event.at, text: `${who} opens, ${bandLabel(event.band)}.`, tone: "lead" };
    if (left <= FINAL_SECONDS) {
      return { at: event.at, text: `${who} snatches it with ${Math.max(1, Math.round(left))} seconds left!`, tone: "snipe" };
    }
    if (leaderBefore === event.bidder) return { at: event.at, text: `${who} goes lower, ${bandLabel(event.band)}.`, tone: "lead" };
    return { at: event.at, text: `${who} takes the lead, ${bandLabel(event.band)}.`, tone: "lead" };
  }
  return {
    at: event.at,
    text: `Clock's out. ${name(event.winner)} wins, ${event.saved_pct}% under the best public price.`,
    tone: "close",
  };
}

/** Everything the public can see at `t` seconds after the clock started. */
export function arenaStateAt(
  events: PublicArenaEvent[],
  bidders: PublicBidder[],
  durationSec: number,
  t: number,
): ArenaState {
  const states = new Map<string, BidderState>(
    bidders.map((b) => [b.id, { bidder: b, joined: false, band: null, leading: false, leads: 0 }]),
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

  for (const s of states.values()) s.leading = s.bidder.id === leaderId;
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

/** The share line on a result card. */
export function resultLine(savedPct: number, wonAtSec: number, perspective: "shopper" | "public", winnerName?: string) {
  const time = durationWords(wonAtSec);
  return perspective === "shopper"
    ? `My agent got ${savedPct}% under the best public price in ${time}.`
    : `${winnerName ?? "A store"} won, ${savedPct}% under the best public price, in ${time}.`;
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
