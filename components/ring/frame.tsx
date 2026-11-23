import { RING_STORES, type StoreId } from "../../lib/ring/cast";
import { clock, euro, money } from "../../lib/ring/words";
import { COSTUMES, type GavelState, type LogRow, type PaddleState, type PaddleView, type RoomView } from "../brand/room";

/**
 * One frame of a practice round: everything the room should show at `t` seconds after the open,
 * built only from the round's log. The live game, the replays and the home page all use it, so a
 * round looks the same however you watch it.
 */

export type RingRow = {
  id: string;
  t: number;
  from: StoreId | "agent" | "clerk";
  to: StoreId | "all" | null;
  kind: string;
  amount_cents: number | null;
  text: string;
  call: string | null;
};

export type RingMeta = {
  lot: number;
  item: string;
  ticket_cents: number;
  window_seconds: number;
  handle: string | null;
  /** "Practice ring. Made-up stores, play money." or a replay label. */
  label: string;
  /** Closed rounds: when the hammer came down (seconds), or null while open. */
  closed_at: number | null;
};

const COSTUME_OF: Record<StoreId, number> = { heron: 0, puddle: 1, toes: 2, fox: 3 };
const short = (id: StoreId) => ({ heron: "the Heron", puddle: "Puddlejump", toes: "Ten Toes", fox: "the Fox" })[id];
const nameOf = (id: StoreId) => RING_STORES.find((s) => s.id === id)!.name;

const QUIET = new Set(["pass", "fold", "hold", "refuse"]);
const TAGS: Record<string, string> = { drop: "Not low enough", accept: "Takes it", refuse: "No", hold: "Holding", pass: "Says nothing", join: "In" };

type Standing = { asks: Partial<Record<StoreId, number>>; changed: Partial<Record<StoreId, number>>; folded: Set<StoreId>; leader: StoreId | null };

function leaderOf(s: Standing): StoreId | null {
  let best: StoreId | null = null;
  for (const store of RING_STORES) {
    const ask = s.asks[store.id];
    if (ask == null || s.folded.has(store.id)) continue;
    if (best == null || ask < s.asks[best]! || (ask === s.asks[best] && (s.changed[store.id] ?? 0) < (s.changed[best] ?? 0))) best = store.id;
  }
  return best;
}

export function agentName(handle: string | null) {
  return handle ?? "you";
}

export function ringFrame(meta: RingMeta, rows: RingRow[], t: number, opts: { still?: boolean; hitWindow?: number } = {}): RoomView & { leader: StoreId | null; sold: boolean } {
  const seen = rows.filter((row) => row.t <= t + 1e-6);
  const standing: Standing = { asks: {}, changed: {}, folded: new Set(), leader: null };
  const leadAt = new Set<string>();
  for (const row of seen) {
    if (row.from !== "agent" && row.from !== "clerk") {
      if (row.amount_cents != null && row.amount_cents !== standing.asks[row.from]) {
        standing.asks[row.from] = row.amount_cents;
        standing.changed[row.from] = row.t;
      }
      if (row.kind === "fold") standing.folded.add(row.from);
      const next = leaderOf(standing);
      if (next === row.from && row.amount_cents != null && !QUIET.has(row.kind)) leadAt.add(row.id);
      standing.leader = next;
    }
  }
  const leader = standing.leader;
  const soldRow = seen.find((row) => row.kind === "sold");
  const sold = Boolean(soldRow) || (meta.closed_at != null && t >= meta.closed_at);
  const secsLeft = Math.max(0, meta.window_seconds - t);
  const last = seen[seen.length - 1];
  const recentStore = last && last.from !== "agent" && last.from !== "clerk" && t - last.t < 1.1 ? last : null;

  // The call: the latest line, then the auctioneer takes over in the last seconds.
  let say = `Lot ${meta.lot}. Who'll go lower?`;
  for (const row of seen) {
    if (row.call) say = row.call;
    else if (row.from === "agent") {
      const who = row.to && row.to !== "all" ? short(row.to as StoreId) : null;
      say = who ? `${agentName(meta.handle) === "you" ? "You lean" : "Your agent leans"} on ${who}.` : `${agentName(meta.handle) === "you" ? "You ask" : "Your agent asks"} the room.`;
    }
  }
  let gavel: GavelState = "rest";
  if (!sold) {
    if (secsLeft <= 1.6) {
      say = "Going twice.";
      gavel = "up2";
    } else if (secsLeft <= 3.1) {
      say = "Going once.";
      gavel = "up1";
    } else if (secsLeft <= 10 && (!last || t - last.t > 2)) {
      say = secsLeft <= 10 && secsLeft > 8 ? "Ten seconds. Anyone?" : say;
    }
  } else {
    const closedAt = soldRow?.t ?? meta.closed_at ?? meta.window_seconds;
    say = soldRow?.call ?? "Sold.";
    gavel = t - closedAt < (opts.hitWindow ?? 1.2) ? "down" : "rest";
  }

  const ticket = meta.ticket_cents;
  const pct = (cents: number) => Math.round(((ticket - cents) / ticket) * 100);
  let leading: RoomView["leading"];
  if (sold && leader) {
    const at = standing.changed[leader] ?? 0;
    leading = (
      <>
        <b>Sold to {nameOf(leader)} at {euro(standing.asks[leader]!)}.</b> <span className="off">{pct(standing.asks[leader]!)}% off</span> in {clock(at)}.
      </>
    );
  } else if (sold) {
    leading = <b>No sale. Everyone folded.</b>;
  } else if (leader) {
    leading = (
      <>
        <b>
          Leading: {nameOf(leader)} at {euro(standing.asks[leader]!)}.
        </b>{" "}
        <span className="off">{pct(standing.asks[leader]!)}% off</span> the ticket price.
      </>
    );
  } else {
    leading = (
      <>
        Haggling: <b>{agentName(meta.handle)}</b>. Nobody has moved yet.
      </>
    );
  }

  const paddles: PaddleView[] = RING_STORES.map((store) => {
    const ask = standing.asks[store.id];
    let state: PaddleState = "down";
    let tag = store.temper;
    if (standing.folded.has(store.id)) {
      state = "folded";
      tag = "Folded";
    } else if (sold && leader === store.id) {
      state = "won";
      tag = "Sold";
    } else if (leader === store.id) {
      state = "lead";
      tag = "Leading";
    } else if (recentStore && recentStore.from === store.id) {
      state = "up";
      tag = TAGS[recentStore.kind] ?? store.temper;
    }
    return {
      id: store.id,
      no: store.no,
      name: store.name,
      amount: standing.folded.has(store.id) ? "Out" : ask != null ? money(ask) : "?",
      state,
      tag,
      costume: COSTUMES[COSTUME_OF[store.id]]!,
    };
  });

  const log: LogRow[] = seen.map((row) => {
    const isStore = row.from !== "agent" && row.from !== "clerk";
    const amount =
      row.amount_cents == null
        ? row.kind === "fold"
          ? "out"
          : row.kind === "pass"
            ? "pass"
            : null
        : row.from === "agent"
          ? `asks ${money(row.amount_cents)}`
          : money(row.amount_cents);
    return {
      key: row.id,
      time: clock(row.t).padStart(5, "0"),
      who: row.from === "agent" ? agentName(meta.handle) : row.from === "clerk" ? "the clerk" : nameOf(row.from as StoreId),
      whoKind: row.from === "agent" ? "agent" : row.from === "clerk" ? "clerk" : "store",
      to: row.from === "agent" ? (row.to === "all" || !row.to ? "everyone" : nameOf(row.to as StoreId)) : null,
      amount,
      lead: leadAt.has(row.id),
      quiet: isStore && QUIET.has(row.kind),
      text: row.text,
      raw: { t: row.t, from: row.from === "agent" ? agentName(meta.handle) : row.from, ...(row.to ? { to: row.to === "all" ? "*" : row.to } : {}), type: row.kind, ...(row.amount_cents != null ? { amount: row.amount_cents / 100 } : {}), say: row.text },
      sold: row.kind === "sold",
    };
  });

  const storyStores = RING_STORES.map((store) =>
    standing.folded.has(store.id) ? `${store.name} folded` : standing.asks[store.id] != null ? `${store.name} at ${euro(standing.asks[store.id]!)}` : `${store.name} hasn't moved`,
  ).join(", ");
  const srSummary = `${meta.label} Lot ${meta.lot}: ${meta.item}, ticket price ${euro(ticket)}. ${sold ? (leader ? `Sold to ${nameOf(leader)} at ${euro(standing.asks[leader]!)}.` : "No sale.") : `${Math.ceil(secsLeft)} seconds left.`} ${storyStores}. The full log is in the clerk's sheet.`;

  return {
    lotNo: `Lot ${meta.lot}`,
    lotText: `${meta.item}. Ticket price ${euro(ticket)}.`,
    tag: <span className="ringtag">{meta.label}</span>,
    say,
    leading,
    seconds: secsLeft,
    tense: !sold && secsLeft <= 10 && secsLeft > 0,
    done: sold,
    gavel,
    hit: sold && gavel === "down",
    paddles,
    log,
    srSummary,
    still: opts.still,
    leader,
    sold,
  };
}

/** The prices a store said on the way down, for crossing out on the card. */
export function bragTrail(log: RingRow[], store: StoreId, final: number, ticket: number): number[] {
  const asks = [...new Set(log.filter((row) => row.from === store && row.amount_cents != null).map((row) => row.amount_cents!))].filter((c) => c > final);
  return (asks.length ? [ticket, ...asks.filter((c) => c !== ticket)] : [ticket]).slice(-3);
}

/** The replay clock: the long middle is squeezed, the last ten seconds get room to breathe. */
export function replayTiming(window: number, fast = 17, slow = 0.85, lead = 0.6) {
  const tail = Math.min(10, window);
  const body = window - tail;
  const toRound = (real: number) => {
    if (real < lead) return 0;
    if (real < lead + fast) return ((real - lead) / fast) * body;
    return Math.min(window, body + (real - lead - fast) / slow);
  };
  const soldReal = lead + fast + tail * slow;
  return { toRound, soldReal, loop: soldReal + 6.5 };
}
