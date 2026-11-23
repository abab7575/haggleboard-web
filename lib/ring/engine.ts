import { ringStore, RING_STORES, STORE_IDS, type StoreId } from "./cast.js";
import { clock, euro, numberWords, sayPrice } from "./words.js";

function shortBy(cents: number): string {
  if (cents < 100) return `${numberWords(cents).replace(/^./, (c) => c.toUpperCase())} cents short.`;
  return `${euro(cents)} short.`;
}

/**
 * THE PRACTICE RING ENGINE. Pure and deterministic: the same round setup and the same haggler
 * messages always give the same store moves. There is no timer process: whoever reads a round
 * replays the simulation up to "now" (lib/ring/service.ts), the same lazy way the real auction
 * closes (lib/auction.ts), and appends any move not yet in the log under a fixed id.
 *
 * Each store is a standing rule (a floor it never goes under, and a temper for how it moves),
 * like a claimed store's rule in watcher/store-rules.ts, plus a voice.
 */

export type RoundSetup = {
  round_id: string;
  /** ms since epoch */
  opened_at: number;
  window_seconds: number;
  ticket_cents: number;
  /** Secret lowest price per store, in cents. Never shown until the round closes. */
  floors: Record<StoreId, number>;
  seed: number;
};

export type Target = StoreId | "all";

export type HagglerMessage = {
  /** Stable id (the event id) so replies get stable ids too. */
  id: string;
  at: number;
  to: Target;
  amount_cents: number | null;
  text: string | null;
};

export type MoveKind = "join" | "drop" | "accept" | "hold" | "refuse" | "pass" | "fold";

export type Move = {
  id: string;
  at: number;
  store: StoreId;
  kind: MoveKind;
  /** The store's ask after this move (null while it has said nothing). */
  ask_cents: number | null;
  /** What the store says, in its own voice. */
  text: string;
  /** The auctioneer's call for this moment, for the big line on the page. */
  call: string;
  reply_to: string | null;
};

export type StoreState = {
  id: StoreId;
  ask: number | null;
  /** Lowest ask it ever made this round. */
  best: number | null;
  /** When it first offered its best (ms). */
  best_at: number | null;
  joined: boolean;
  folded: boolean;
  cracked: boolean;
  pressure: number;
  /** When its ask last changed (ms), for ties. */
  changed_at: number | null;
};

export type Simulation = { moves: Move[]; states: Record<StoreId, StoreState>; leader: StoreId | null };

/** mulberry32: small, fast, good enough for made-up prices. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Secret floors for a round: one draw per store inside its range, rounded to 50 cents. */
export function drawFloors(seed: number, ticket_cents: number): Record<StoreId, number> {
  const next = rng(seed ^ 0x9e3779b9);
  const floors = {} as Record<StoreId, number>;
  for (const store of RING_STORES) {
    const [lo, hi] = store.floor_range;
    const share = lo + (hi - lo) * next();
    floors[store.id] = Math.round((ticket_cents * share) / 50) * 50;
  }
  return floors;
}

const euroRound = (cents: number) => Math.round(cents / 100) * 100;
const halfRound = (cents: number) => Math.round(cents / 50) * 50;
/** Never under the floor; rounded up onto the floor's own grid when it gets there. */
const atLeast = (cents: number, floor: number) => Math.max(floor, cents);

type Trigger =
  | { kind: "tick"; id: string; at: number; store: StoreId; step: string }
  | { kind: "reply"; id: string; at: number; store: StoreId; message: HagglerMessage }
  | { kind: "react"; id: string; at: number; store: StoreId };

function pick<T>(list: T[], r: number): T {
  return list[Math.floor(r * list.length) % list.length]!;
}

/** Scheduled looks, as fractions of the window. */
const SCHEDULE: Array<{ store: StoreId; at: number; step: string }> = [
  { store: "puddle", at: 0.05, step: "join" },
  { store: "toes", at: 0.09, step: "join" },
  { store: "heron", at: 0.14, step: "join" },
  { store: "puddle", at: 0.18, step: "drop" },
  { store: "puddle", at: 0.31, step: "drop" },
  { store: "heron", at: 0.33, step: "drop" },
  { store: "puddle", at: 0.44, step: "drop" },
  { store: "heron", at: 0.52, step: "drop" },
  { store: "puddle", at: 0.56, step: "fold" },
  { store: "heron", at: 0.7, step: "drop" },
  { store: "heron", at: 0.84, step: "crack" },
  { store: "fox", at: 0.875, step: "join" },
  { store: "fox", at: 0.95, step: "drop" },
];

export function leaderOf(states: Record<StoreId, StoreState>): StoreId | null {
  let best: StoreState | null = null;
  for (const id of STORE_IDS) {
    const s = states[id];
    if (!s.joined || s.folded || s.ask == null) continue;
    if (
      !best ||
      s.ask < best.ask! ||
      (s.ask === best.ask && (s.changed_at ?? Infinity) < (best.changed_at ?? Infinity))
    ) {
      best = s;
    }
  }
  return best?.id ?? null;
}

function freshStates(): Record<StoreId, StoreState> {
  const states = {} as Record<StoreId, StoreState>;
  for (const id of STORE_IDS) {
    states[id] = { id, ask: null, best: null, best_at: null, joined: false, folded: false, cracked: false, pressure: 0, changed_at: null };
  }
  return states;
}

/**
 * Replays a round up to `until` (ms). Messages after `until` or after the deadline are ignored.
 * Moves that would land after the deadline are dropped: the hammer comes down on the deadline.
 */
export function simulate(setup: RoundSetup, messages: HagglerMessage[], until: number): Simulation {
  const deadline = setup.opened_at + setup.window_seconds * 1000;
  const end = Math.min(until, deadline);
  const states = freshStates();
  const moves: Move[] = [];
  const ticket = setup.ticket_cents;
  const queue: Trigger[] = [];

  for (const item of SCHEDULE) {
    queue.push({ kind: "tick", id: `t:${item.store}:${item.step}:${item.at}`, at: setup.opened_at + item.at * setup.window_seconds * 1000, store: item.store, step: item.step });
  }
  for (const message of messages) {
    if (message.at > end || message.at < setup.opened_at) continue;
    const targets = message.to === "all" ? STORE_IDS : [message.to];
    for (const store of targets) {
      queue.push({ kind: "reply", id: `r:${message.id}:${store}`, at: message.at + ringStore(store).reply_ms, store, message });
    }
  }

  const sortQueue = () => queue.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  sortQueue();

  const frac = (at: number) => (at - setup.opened_at) / (setup.window_seconds * 1000);

  const apply = (trigger: Trigger, kind: MoveKind, ask: number | null, text: string, call: string) => {
    const s = states[trigger.store];
    if (kind === "fold") s.folded = true;
    if (kind === "join") s.joined = true;
    if (ask != null && ask !== s.ask) {
      s.ask = ask;
      s.changed_at = trigger.at;
      if (s.best == null || ask < s.best) {
        s.best = ask;
        s.best_at = trigger.at;
      }
    }
    const before = moves.length ? leaderAfter : null;
    moves.push({
      id: trigger.id,
      at: trigger.at,
      store: trigger.store,
      kind,
      ask_cents: s.ask,
      text,
      call,
      reply_to: trigger.kind === "reply" ? trigger.message.id : null,
    });
    const now = leaderOf(states);
    leaderAfter = now;
    // Ten Toes watches the lead: whenever someone else takes it, it answers one under.
    if (now && now !== "toes" && now !== before && states.toes.joined && !states.toes.folded) {
      queue.push({ kind: "react", id: `x:${trigger.id}`, at: trigger.at + ringStore("toes").reply_ms, store: "toes" });
      sortQueue();
    }
  };
  let leaderAfter: StoreId | null = null;

  while (queue.length) {
    const trigger = queue[0]!;
    if (trigger.at > end) break;
    queue.shift();
    const s = states[trigger.store];
    const floor = setup.floors[trigger.store];
    const gap = Math.max(0, ticket - floor);
    // Moves a store makes on its own, or when merely nagged, stop short of the floor. Only a named price at or above the floor (an accepted counter) gets right down to it.
    const comfort = (share: number) => floor + Math.ceil((gap * share) / 50) * 50;
    const r = rng(hashSeed(`${setup.seed}:${trigger.id}`));
    const leader = leaderOf(states);
    const leaderAsk = leader ? states[leader].ask : null;
    if (s.folded) continue;

    if (trigger.store === "puddle") {
      if (trigger.kind === "tick" && trigger.step === "join" && !s.joined) {
        const ask = euroRound(ticket * (0.91 + r() * 0.02));
        apply(trigger, "join", ask, `${sayPrice(ask)}! Quick, before I change my mind.`, "Puddlejump jumps first.");
      } else if (trigger.kind === "tick" && trigger.step === "drop" && s.joined) {
        const drop = ticket * (0.035 + r() * 0.025) * (1 + 0.35 * s.pressure);
        const ask = atLeast(euroRound(s.ask! - drop), comfort(0.3));
        if (ask < s.ask!) {
          const p = sayPrice(ask);
          apply(trigger, "drop", ask, pick([`${p}. Is that good? That's good.`, `${p}! No, wait. Yes. ${p}.`, `Okay, okay. ${p}.`, `${p}. Please?`], r()), "Puddlejump panics lower.");
        }
        // Says it once; after that it just sweats quietly.
        else if (![...moves].reverse().find((m) => m.store === "puddle" && m.kind !== "refuse")?.kind.startsWith("hold")) apply(trigger, "hold", s.ask, "That's it. That's all I've got.", "Puddlejump is running on fumes.");
      } else if (trigger.kind === "tick" && trigger.step === "fold") {
        apply(trigger, "fold", s.ask, pick(["Can't. Out. Sorry.", "Too much. I'm out.", "Nope. Folding. Bye."], r()), "Puddlejump folds.");
      } else if (trigger.kind === "reply") {
        const m = trigger.message;
        s.pressure += 1;
        if (!s.joined) {
          const ask = euroRound(ticket * 0.9);
          apply(trigger, "join", ask, `${sayPrice(ask)}! Don't shout, I'm here.`, "You flushed out Puddlejump.");
        } else if (m.amount_cents != null && m.amount_cents >= floor && m.amount_cents < s.ask!) {
          const ask = halfRound(m.amount_cents) < floor ? floor : halfRound(m.amount_cents);
          apply(trigger, "accept", ask, `${sayPrice(ask)}. Yes. Fine. Deal. I think.`, `Puddlejump takes your ${euro(ask)}.`);
        } else if (s.ask! <= comfort(0.08)) {
          if (s.pressure >= 4) apply(trigger, "fold", s.ask, "That's too scary. I'm out.", "You scared Puddlejump out of the room.");
          else apply(trigger, "refuse", s.ask, "No no no. I can't. I really can't.", "Puddlejump is at the wall.");
        } else {
          const ask = atLeast(euroRound(s.ask! - gap * (m.amount_cents == null ? 0.18 : 0.32)), comfort(0.08));
          apply(trigger, "drop", ask, `Eek. ${sayPrice(ask)}?`, "Puddlejump panics lower.");
        }
      }
      continue;
    }

    if (trigger.store === "toes") {
      const underLeader = leaderAsk != null && leader !== "toes" ? leaderAsk - 100 : null;
      if (trigger.kind === "tick" && trigger.step === "join" && !s.joined) {
        const target = underLeader ?? euroRound(ticket * 0.95);
        const ask = atLeast(target, comfort(0.2));
        apply(trigger, "join", ask, `${sayPrice(ask)}.`, underLeader != null ? "Ten Toes goes one under." : "Ten Toes is in.");
      } else if (trigger.kind === "react" && s.joined) {
        if (leader === "toes" || underLeader == null) continue;
        if (underLeader >= floor && underLeader < s.ask!) {
          apply(trigger, "drop", underLeader, `${sayPrice(underLeader)}.`, pick(["Ten Toes, one under. Again.", "Ten Toes goes one under.", "One under. Ten Toes never misses."], r()));
        } else if (underLeader < floor) {
          apply(trigger, "hold", s.ask, "Can't go one under that. I've got feet to feed.", "Ten Toes can't follow.");
        }
      } else if (trigger.kind === "reply") {
        const m = trigger.message;
        s.pressure += 1;
        if (!s.joined) {
          const ask = atLeast(underLeader ?? euroRound(ticket * 0.95), comfort(0.2));
          apply(trigger, "join", ask, `${sayPrice(ask)}.`, "Ten Toes is in.");
        } else if (leader === "toes") {
          apply(trigger, "hold", s.ask, "I'm already the cheapest. One under myself? Cheeky.", "Ten Toes holds.");
        } else if (underLeader != null && underLeader >= floor && underLeader < s.ask!) {
          apply(trigger, "drop", underLeader, `One under the leader. ${sayPrice(underLeader)}. That's my whole thing.`, "Ten Toes goes one under.");
        } else {
          apply(trigger, "refuse", s.ask, "One under the leader, not one under your dreams.", "Ten Toes sticks to its one rule.");
        }
      }
      continue;
    }

    if (trigger.store === "heron") {
      const keep = floor + gap * 0.5;
      if (trigger.kind === "tick" && trigger.step === "join" && !s.joined) {
        const ask = ticket - 100;
        apply(trigger, "join", ask, `${sayPrice(ask)}. Take it or leave it.`, "Grumpy Heron doesn't budge for just anyone.");
      } else if (trigger.kind === "tick" && trigger.step === "drop" && s.joined && !s.cracked) {
        const step = euroRound(ticket * (0.01 + r() * 0.01)) || 100;
        const ask = Math.max(euroRound(keep), s.ask! - step);
        if (ask < s.ask!) apply(trigger, "drop", ask, pick([`Fine. ${sayPrice(ask)}. Happy?`, `${sayPrice(ask)}. Grudgingly.`, `${sayPrice(ask)}. Don't push it.`], r()), `Grumpy Heron gives up ${numberWords((s.ask! - ask) / 100)} euro. Grudgingly.`);
      } else if (trigger.kind === "tick" && trigger.step === "crack" && s.joined && !s.cracked) {
        const ask = atLeast(euroRound(floor + gap * (s.pressure >= 2 ? 0.2 : 0.5)), floor);
        s.cracked = true;
        if (ask < s.ask!) apply(trigger, "drop", ask, `Oh, fine. ${sayPrice(ask)}.`, "Grumpy Heron sags a little.");
      } else if (trigger.kind === "reply") {
        const m = trigger.message;
        if (m.to === "all") {
          if (s.joined) apply(trigger, "pass", s.ask, "Not for everyone. Ask me properly.", "Grumpy Heron ignores the room.");
          continue;
        }
        s.pressure += 1;
        if (!s.joined) {
          const ask = ticket - 100;
          apply(trigger, "join", ask, `${sayPrice(ask)}. And I'm being generous.`, "Grumpy Heron grumbles in.");
        } else if (!s.cracked && s.pressure >= 3 && frac(trigger.at) >= 0.45) {
          s.cracked = true;
          const crack = atLeast(euroRound(floor + gap * 0.08), floor);
          const ask = m.amount_cents != null && m.amount_cents >= floor && m.amount_cents < s.ask! ? Math.max(halfRound(m.amount_cents), floor) : Math.min(crack, s.ask!);
          apply(trigger, "accept", ask, `${sayPrice(ask)}. Don't tell anyone.`, `Grumpy Heron cracks. ${euro(ask).replace("€", "")}.`);
        } else if (s.cracked && m.amount_cents != null && m.amount_cents >= floor && m.amount_cents < s.ask!) {
          const ask = Math.max(halfRound(m.amount_cents), floor);
          apply(trigger, "accept", ask, `${sayPrice(ask)}. Happy now?`, `Grumpy Heron takes ${euro(ask)}.`);
        } else if (s.cracked) {
          const ask = atLeast(s.ask! - 100, comfort(0.05));
          if (ask < s.ask!) apply(trigger, "drop", ask, `No. ${sayPrice(ask)}, and that's charity.`, "Grumpy Heron gives a euro. One.");
          else apply(trigger, "refuse", s.ask, "No.", "Grumpy Heron says no.");
        } else {
          const ask = Math.max(euroRound(keep), s.ask! - 100);
          if (ask < s.ask!) apply(trigger, "drop", ask, pick([`${sayPrice(ask)}. Grudgingly.`, `${sayPrice(ask)}. That's all you get.`, `${sayPrice(ask)}, and I'm not happy about it.`], r()), "Grumpy Heron gives a euro. One.");
          else apply(trigger, "refuse", s.ask, "Not for that.", "Grumpy Heron folds its arms.");
        }
      }
      continue;
    }

    // Wobbly Fox
    const foxTarget = (lead: number | null, under: number) => atLeast(halfRound((lead ?? euroRound(ticket * 0.9)) - under), comfort(0.25));
    if (trigger.kind === "tick" && trigger.step === "join" && !s.joined) {
      const ask = foxTarget(leader && leader !== "fox" ? leaderAsk : null, s.pressure >= 2 ? 200 : 50);
      const short = leader && leader !== "fox" && leaderAsk != null && ask >= leaderAsk ? ask - leaderAsk : null;
      apply(trigger, "join", ask, `${sayPrice(ask)}.`, short == null ? "Wobbly Fox sneaks in late." : short === 0 ? "Wobbly Fox sneaks in late. Level, not under." : `Wobbly Fox sneaks in late. ${shortBy(short)}`);
    } else if (trigger.kind === "tick" && trigger.step === "drop" && s.joined) {
      if (leader === "fox" || leaderAsk == null) continue;
      const ask = foxTarget(leaderAsk, 50);
      if (ask < s.ask!) apply(trigger, "drop", ask, `${sayPrice(ask)}. Last word.`, "Wobbly Fox has the last word.");
    } else if (trigger.kind === "reply") {
      const m = trigger.message;
      s.pressure += 1;
      if (!s.joined) {
        apply(trigger, "pass", null, "(says nothing)", "Wobbly Fox hasn't moved. Watch the fox.");
      } else if (m.amount_cents != null && m.amount_cents >= floor && m.amount_cents < s.ask!) {
        const ask = Math.max(halfRound(m.amount_cents), floor);
        apply(trigger, "accept", ask, `${sayPrice(ask)}. Shh.`, `Wobbly Fox takes ${euro(ask)}.`);
      } else {
        const ask = atLeast(s.ask! - 100, comfort(0.05));
        if (ask < s.ask!) apply(trigger, "drop", ask, `Sly. ${sayPrice(ask)}.`, "Wobbly Fox shuffles lower.");
        else apply(trigger, "refuse", s.ask, "Ha. No.", "Wobbly Fox grins and holds.");
      }
    }
  }
  return { moves, states, leader: leaderOf(states) };
}

export type StoreScore = {
  store: StoreId;
  name: string;
  floor_cents: number;
  final_cents: number;
  /** How far the final price sits above the store's secret lowest price, in percent. */
  above_floor_pct: number;
  /** How far under the ticket price, in percent. */
  down_pct: number;
  /** Seconds after the open that it first offered its final price. */
  at_seconds: number | null;
  folded: boolean;
};

export type RoundResult = {
  winner: StoreId | null;
  winner_cents: number | null;
  /** Mean of above_floor_pct across the four stores. Lower is better. */
  score_pct: number;
  /** Seconds after the open that the winning price was first offered. */
  time_seconds: number | null;
  stores: StoreScore[];
  best_crack: StoreScore;
  brag: string;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/** The close: who won, and how close the haggler got each store to its secret floor. */
export function scoreRound(setup: RoundSetup, sim: Simulation): RoundResult {
  const stores: StoreScore[] = RING_STORES.map((store) => {
    const s = sim.states[store.id];
    const floor = setup.floors[store.id];
    const final = s.best ?? setup.ticket_cents;
    return {
      store: store.id,
      name: store.name,
      floor_cents: floor,
      final_cents: final,
      above_floor_pct: round1(((final - floor) / floor) * 100),
      down_pct: round1(((setup.ticket_cents - final) / setup.ticket_cents) * 100),
      at_seconds: s.best_at == null ? null : round1((s.best_at - setup.opened_at) / 1000),
      folded: s.folded,
    };
  });
  const winner = sim.leader;
  const best = [...stores].sort((a, b) => b.down_pct - a.down_pct || a.above_floor_pct - b.above_floor_pct)[0]!;
  const score = round1(stores.reduce((sum, item) => sum + item.above_floor_pct, 0) / stores.length);
  const winnerAt = winner ? sim.states[winner].changed_at : null;
  return {
    winner,
    winner_cents: winner ? sim.states[winner].ask : null,
    score_pct: score,
    time_seconds: winnerAt == null ? null : round1((winnerAt - setup.opened_at) / 1000),
    stores,
    best_crack: best,
    brag: `My agent got ${best.name} down ${Math.round(best.down_pct)}% in ${clock(best.at_seconds ?? 0)}. Beat that.`,
  };
}

/** Reads "Heron, 78?" or "75 to Ten Toes" into a target and an amount, for people typing freely. */
export function readLine(text: string, ticket_cents: number): { to: Target; amount_cents: number | null } {
  const lower = text.toLowerCase();
  let to: Target = "all";
  if (/heron|grumpy/.test(lower)) to = "heron";
  else if (/puddle/.test(lower)) to = "puddle";
  else if (/toes|ten toes/.test(lower)) to = "toes";
  else if (/fox|wobbly/.test(lower)) to = "fox";
  const number = lower.replace(/ten toes/g, "").match(/(?:€|eur\s*)?(\d{1,4}(?:[.,]\d{1,2})?)/);
  let amount: number | null = null;
  if (number) {
    const value = Math.round(Number(number[1]!.replace(",", ".")) * 100);
    if (value > 0 && value <= ticket_cents * 2) amount = value;
  }
  return { to, amount_cents: amount };
}
