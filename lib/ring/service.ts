import { randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import { CLOSE_GRACE_MS } from "../auction.js";
import type { Store } from "../db.js";
import { eventStatement, requestEvents, serviceContext, type EventContext, type EventRow, type NewEvent } from "../events.js";
import { HttpError } from "../http.js";
import { deleteTokenHmac, deleteTokenKey, hmacEqual, newDeleteToken } from "../keys.js";
import { scrubPublicText } from "../privacy.js";
import { handleSchema, allowedSchema } from "../service.js";
import { LOTS, RING_CURRENCY, RING_MAX_MESSAGES, RING_MAX_SECONDS, RING_MIN_SECONDS, RING_STORES, RING_WINDOW_SECONDS, ringStore, STORE_IDS, type StoreId } from "./cast.js";
import { drawFloors, readLine, scoreRound, simulate, type HagglerMessage, type Move, type RoundResult, type RoundSetup, type Target } from "./engine.js";
import { clock, euro } from "./words.js";

/**
 * THE PRACTICE RING, stored. Every round lives in the one event log (lib/events.ts) under its own
 * event types, so it can never be mistaken for real shopping:
 *
 *   ring.opened   the lot, the ticket price, who is playing; PRIVATE: the four secret floors and the key's HMAC
 *   ring.message  what the haggler said (to one store or everyone, an amount, a scrubbed line)
 *   ring.store    what a practice store did, written lazily under a fixed id when someone reads the round
 *   ring.closed   the result and the score, with the floors revealed
 *
 * Every row carries public.practice = true. Rounds never touch the requests table, so they are never
 * on the board, in the sitemap, in JSON-LD, on a store page or in a store notification, and the
 * real-shopping statistics (lib/stats.ts) only read real event types. Practice stores are bots in
 * this file and lib/ring/engine.ts: no round ever makes an outside request.
 */

export type RingDeps = { store: Store; context?: EventContext };

const PRACTICE = { practice: true } as const;
const keyFor = (id: string) => `ring:${id}`;

const runsOnSchema = z
  .string()
  .trim()
  .max(40)
  .regex(/^[\p{L}\p{N} .,_+\-/()]*$/u, "runs_on: letters, digits, spaces and . , _ + - / ( ) only");

export const startSchema = z
  .object({
    agent: handleSchema.optional(),
    runs_on: runsOnSchema.optional(),
    /** "agent" when an agent plays through the API or MCP, "hand" when a person plays on the page. */
    mode: z.enum(["agent", "hand"]).optional(),
    opening: z.string().trim().max(200).optional(),
    window_seconds: z.number().int().min(RING_MIN_SECONDS).max(RING_MAX_SECONDS).optional(),
    allowed: allowedSchema.optional(),
  })
  .strict();

export const saySchema = z
  .object({
    key: z.string().trim().min(16).max(200),
    to: z.enum(["all", ...STORE_IDS] as [string, ...string[]]).optional(),
    amount: z.number().positive().max(100_000).optional(),
    text: z.string().trim().max(200).optional(),
  })
  .strict();

type Opened = { event: EventRow; setup: RoundSetup; key_hmac: string };

function opened(events: EventRow[]): Opened | null {
  const event = events.find((item) => item.type === "ring.opened");
  if (!event) return null;
  const p = event.public;
  const floors = event.private.floors as Record<StoreId, number>;
  return {
    event,
    key_hmac: String(event.private.key_hmac ?? ""),
    setup: {
      round_id: String(event.request_id),
      opened_at: Date.parse(String(p.opened_at)),
      window_seconds: Number(p.window_seconds),
      ticket_cents: Number(p.ticket_cents),
      floors,
      seed: Number(event.private.seed),
    },
  };
}

function messagesOf(events: EventRow[]): HagglerMessage[] {
  return events
    .filter((event) => event.type === "ring.message")
    .map((event) => ({
      id: event.id,
      at: Date.parse(event.at),
      to: String(event.public.to) as Target,
      amount_cents: typeof event.public.amount_cents === "number" ? event.public.amount_cents : null,
      text: typeof event.public.text === "string" ? event.public.text : null,
    }));
}

function assertStore(store: Store) {
  if (store.kind === "unavailable") throw new HttpError(503, "The practice ring needs a database (DATABASE_URL). Nothing was stored.");
}

async function nextLot(store: Store): Promise<number> {
  const row = (await store.select("SELECT COUNT(*) AS n FROM events WHERE type = 'ring.opened'"))[0];
  return 400 + Number(row?.n ?? 0) + 1;
}

/** Starts a round. Returns the round id and its key once: the key is needed to say anything. */
export async function startRound(input: unknown, deps: RingDeps, now = Date.now()) {
  assertStore(deps.store);
  const parsed = startSchema.safeParse(input ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(400, `That round can't start: ${issue?.message ?? "check the fields"}`);
  }
  const body = parsed.data;
  const ctx = deps.context ?? serviceContext("service");
  const id = randomUUID();
  const key = newDeleteToken();
  const seed = randomInt(0, 2 ** 31);
  const lot = await nextLot(deps.store);
  const pickLot = LOTS[seed % LOTS.length]!;
  const window_seconds = body.window_seconds ?? RING_WINDOW_SECONDS;
  const floors = drawFloors(seed, pickLot.ticket_cents);
  const openedAt = new Date(now).toISOString();
  const event: NewEvent = {
    type: "ring.opened",
    at: openedAt,
    request_id: id,
    public: {
      ...PRACTICE,
      lot,
      item: pickLot.item,
      ticket_cents: pickLot.ticket_cents,
      currency: RING_CURRENCY,
      window_seconds,
      opened_at: openedAt,
      deadline: new Date(now + window_seconds * 1000).toISOString(),
      handle: body.agent ?? null,
      runs_on: scrubPublicText(body.runs_on ?? null),
      mode: body.mode ?? "agent",
      channel: ctx.channel,
      agent_kind: ctx.agent.kind,
      rules: 1,
    },
    private: {
      floors,
      seed,
      key_hmac: deleteTokenHmac(deleteTokenKey(), keyFor(id), key),
      ...(body.allowed ? { allowed: body.allowed } : {}),
    },
  };
  await deps.store.batch([eventStatement(event, ctx)]);
  if (body.opening) await say(id, { key, text: body.opening }, deps, now);
  const state = await roundState(id, deps, now);
  return {
    ...state,
    key,
    how: {
      say: `POST /api/ring/${id}/say with {"key", "to": "heron" | "puddle" | "toes" | "fox" | "all", "amount": 78, "text": "..."}`,
      state: `GET /api/ring/${id}?wait=5`,
      watch: `/ring/${id}`,
    },
  };
}

/** The haggler says something. Stores answer a second or so later, in character. */
export async function say(id: string, input: unknown, deps: RingDeps, now = Date.now()) {
  assertStore(deps.store);
  const parsed = saySchema.safeParse(input ?? {});
  if (!parsed.success) throw new HttpError(400, "Send key, and at least one of to, amount or text.");
  const events = await requestEvents(deps.store, id);
  const open = opened(events);
  if (!open) throw new HttpError(404, "No practice round with that id.");
  const expected = open.key_hmac;
  const actual = deleteTokenHmac(deleteTokenKey(), keyFor(id), parsed.data.key);
  if (!hmacEqual(expected, actual)) throw new HttpError(403, "That key doesn't match this round.");
  const deadline = open.setup.opened_at + open.setup.window_seconds * 1000;
  if (now >= deadline) throw new HttpError(409, "The hammer's already down on this round. Start another.");
  const sent = events.filter((event) => event.type === "ring.message").length;
  if (sent >= RING_MAX_MESSAGES) throw new HttpError(429, `That's ${RING_MAX_MESSAGES} messages. Let the stores think.`);
  const text = scrubPublicText(parsed.data.text ?? null);
  const read = text ? readLine(text, open.setup.ticket_cents) : { to: "all" as Target, amount_cents: null };
  const to = (parsed.data.to as Target | undefined) ?? read.to;
  const amount = parsed.data.amount != null ? Math.round(parsed.data.amount * 100) : read.amount_cents;
  if (!text && amount == null && !parsed.data.to) throw new HttpError(400, "Say something: a store, an amount, or a line.");
  await persist(deps.store, id, events, open, now);
  await deps.store.batch([
    eventStatement(
      {
        type: "ring.message",
        at: new Date(now).toISOString(),
        request_id: id,
        internal: open.event.internal,
        public: { ...PRACTICE, to, amount_cents: amount, text, kind: amount == null ? "say" : to === "all" ? "ask" : "counter" },
      },
      deps.context ?? null,
    ),
  ]);
  return roundState(id, deps, now);
}

/** Appends any store move or close that is due and not yet in the log. Fixed ids: racing readers write once. */
async function persist(store: Store, id: string, events: EventRow[], open: Opened, now: number) {
  const sim = simulate(open.setup, messagesOf(events), now);
  const have = new Set(events.map((event) => event.id));
  const rows = sim.moves
    .filter((move) => !have.has(`${id}:${move.id}`))
    .map((move) =>
      eventStatement(
        {
          id: `${id}:${move.id}`,
          type: "ring.store",
          at: new Date(move.at).toISOString(),
          request_id: id,
          internal: open.event.internal,
          agent_class: "practice-store",
          public: { ...PRACTICE, store: move.store, kind: move.kind, ask_cents: move.ask_cents, text: move.text, call: move.call, reply_to: move.reply_to },
        },
        null,
      ),
    );
  const deadline = open.setup.opened_at + open.setup.window_seconds * 1000;
  const closedId = `${id}:ring.closed`;
  if (now >= deadline + CLOSE_GRACE_MS / 4 && !have.has(closedId)) {
    const result = scoreRound(open.setup, sim);
    rows.push(
      eventStatement(
        {
          id: closedId,
          type: "ring.closed",
          at: new Date(deadline).toISOString(),
          request_id: id,
          internal: open.event.internal,
          agent_class: open.event.agent_class,
          public: {
            ...PRACTICE,
            handle: open.event.public.handle ?? null,
            runs_on: open.event.public.runs_on ?? null,
            mode: open.event.public.mode ?? "agent",
            window_seconds: open.setup.window_seconds,
            lot: open.event.public.lot,
            item: open.event.public.item,
            ticket_cents: open.setup.ticket_cents,
            messages: messagesOf(events).length,
            ...result,
            // A person playing by hand brags about themselves, not an agent.
            brag: open.event.public.mode === "hand" ? result.brag.replace("My agent got", "I got") : result.brag,
          },
        },
        null,
      ),
    );
  }
  if (rows.length) await store.batch(rows);
  return sim;
}

export type RingLogRow = {
  id: string;
  /** Seconds since the open. */
  t: number;
  from: StoreId | "agent" | "clerk";
  to: Target | null;
  kind: string;
  amount_cents: number | null;
  text: string;
  call: string | null;
};

export type RingState = Awaited<ReturnType<typeof roundState>>;

/** Everything about a round that anyone may see. The floors appear only after the hammer. */
export async function roundState(id: string, deps: RingDeps, now = Date.now()) {
  assertStore(deps.store);
  let events = await requestEvents(deps.store, id);
  const open = opened(events);
  if (!open) throw new HttpError(404, "No practice round with that id.");
  const sim = await persist(deps.store, id, events, open, now);
  events = await requestEvents(deps.store, id);
  const deadline = open.setup.opened_at + open.setup.window_seconds * 1000;
  const closed = events.find((event) => event.type === "ring.closed");
  const status = closed ? "closed" : now >= deadline ? "closing" : "open";
  const result = closed ? (closed.public as unknown as RoundResult) : null;
  const handle = (open.event.public.handle as string | null) ?? null;
  const log: RingLogRow[] = [];
  for (const event of events) {
    const t = Math.round(((Date.parse(event.at) - open.setup.opened_at) / 1000) * 10) / 10;
    if (event.type === "ring.message") {
      const amount = typeof event.public.amount_cents === "number" ? event.public.amount_cents : null;
      log.push({
        id: event.id,
        t,
        from: "agent",
        to: String(event.public.to) as Target,
        kind: String(event.public.kind),
        amount_cents: amount,
        text: (event.public.text as string | null) ?? (amount != null ? `${euro(amount)}?` : "..."),
        call: null,
      });
    } else if (event.type === "ring.store") {
      log.push({
        id: event.id,
        t,
        from: String(event.public.store) as StoreId,
        to: null,
        kind: String(event.public.kind),
        amount_cents: (event.public.ask_cents as number | null) ?? null,
        text: String(event.public.text),
        call: (event.public.call as string | null) ?? null,
      });
    } else if (event.type === "ring.closed" && result) {
      const winner = result.winner ? ringStore(result.winner).name : null;
      log.push({
        id: event.id,
        t,
        from: "clerk",
        to: null,
        kind: "sold",
        amount_cents: result.winner_cents,
        text: winner
          ? `Sold to ${winner} at ${euro(result.winner_cents!)}. ${Math.round(((open.setup.ticket_cents - result.winner_cents!) / open.setup.ticket_cents) * 100)}% off the ticket.`
          : "No sale. Nobody stayed in.",
        call: winner ? `Sold. ${winner.split(" ").pop()} down ${Math.round(((open.setup.ticket_cents - result.winner_cents!) / open.setup.ticket_cents) * 100)}%.` : "No sale.",
      });
    }
  }
  log.sort((a, b) => a.t - b.t || (a.from === "agent" ? -1 : 1));
  const stores = RING_STORES.map((store) => {
    const s = sim.states[store.id];
    return {
      id: store.id,
      name: store.name,
      no: store.no,
      temper: store.temper,
      joined: s.joined,
      folded: s.folded,
      ask_cents: s.ask,
      best_cents: s.best,
      leading: sim.leader === store.id,
      ...(result ? { floor_cents: open.setup.floors[store.id] } : {}),
    };
  });
  return {
    practice: true as const,
    note: "Practice ring. Made-up stores, play money. Nobody pays, nothing ships.",
    round_id: id,
    lot: Number(open.event.public.lot),
    item: String(open.event.public.item),
    ticket_cents: open.setup.ticket_cents,
    currency: RING_CURRENCY,
    handle,
    runs_on: (open.event.public.runs_on as string | null) ?? null,
    mode: (open.event.public.mode as string | null) ?? "agent",
    lab: open.event.internal,
    opened_at: new Date(open.setup.opened_at).toISOString(),
    deadline: new Date(deadline).toISOString(),
    window_seconds: open.setup.window_seconds,
    seconds_left: Math.max(0, Math.ceil((deadline - now) / 1000)),
    now: new Date(now).toISOString(),
    status,
    leader: sim.leader,
    stores,
    log,
    result: result
      ? {
          ...result,
          card: `/ring/${id}/card`,
          page: `/ring/${id}`,
          brag_line: `${result.brag} haggleboard.com/ring/${id}`,
        }
      : null,
  };
}

/** Waits up to wait_seconds for something new (a store reply, or the close). */
export async function waitForRound(id: string, deps: RingDeps, waitSeconds: number, opts: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const until = now() + Math.max(0, Math.min(25, waitSeconds)) * 1000;
  let state = await roundState(id, deps, now());
  const seen = state.log.length;
  while (now() < until && state.status !== "closed") {
    await sleep(Math.min(700, Math.max(50, until - now())));
    state = await roundState(id, deps, now());
    if (state.log.length > seen) break;
  }
  return state;
}

export type LeagueRow = {
  rank: number;
  handle: string;
  runs_on: string | null;
  mode: string;
  lab: boolean;
  rounds: number;
  score_pct: number;
  time_seconds: number | null;
  best_crack: { store: StoreId; name: string; down_pct: number };
  per_store: Array<{ store: StoreId; name: string; above_floor_pct: number }>;
  round_id: string;
};

/**
 * The league, from real closed rounds only. Each handle's best two-minute round, ranked by how close
 * it got the four stores to their floors (lower is better), then by time. Our own lab runs are flagged
 * and left out unless asked for. Rounds without a handle are not ranked.
 */
export async function league(store: Store, opts: { includeLab?: boolean; limit?: number } = {}) {
  if (store.kind === "unavailable") return { as_of: new Date().toISOString(), rows: [] as LeagueRow[], rounds: 0, lab_rounds: 0 };
  const rows = await store.select(
    "SELECT id, at, type, request_id, store_domain, agent_class, internal, public, private FROM events WHERE type = 'ring.closed' ORDER BY at ASC",
  );
  const all = rows.map((row) => ({ internal: Number(row.internal) === 1, request_id: String(row.request_id), pub: (typeof row.public === "string" ? JSON.parse(row.public) : row.public) as Record<string, unknown> }));
  const fair = all.filter((row) => Number(row.pub.window_seconds) === RING_WINDOW_SECONDS);
  const counted = fair.filter((row) => opts.includeLab || !row.internal);
  const best = new Map<string, LeagueRow>();
  const counts = new Map<string, number>();
  for (const row of counted) {
    const handle = typeof row.pub.handle === "string" ? row.pub.handle : null;
    if (!handle) continue;
    const key = `${handle}\n${row.internal ? "lab" : "real"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const stores = (row.pub.stores as RoundResult["stores"]) ?? [];
    const crack = row.pub.best_crack as RoundResult["best_crack"];
    const candidate: LeagueRow = {
      rank: 0,
      handle,
      runs_on: (row.pub.runs_on as string | null) ?? null,
      mode: String(row.pub.mode ?? "agent"),
      lab: row.internal,
      rounds: 0,
      score_pct: Number(row.pub.score_pct),
      time_seconds: row.pub.time_seconds == null ? null : Number(row.pub.time_seconds),
      best_crack: { store: crack.store, name: crack.name, down_pct: crack.down_pct },
      per_store: stores.map((item) => ({ store: item.store, name: item.name, above_floor_pct: item.above_floor_pct })),
      round_id: row.request_id,
    };
    const current = best.get(key);
    if (
      !current ||
      candidate.score_pct < current.score_pct ||
      (candidate.score_pct === current.score_pct && (candidate.time_seconds ?? 1e9) < (current.time_seconds ?? 1e9))
    ) {
      best.set(key, candidate);
    }
  }
  const ranked = [...best.entries()]
    .map(([key, row]) => ({ ...row, rounds: counts.get(key) ?? 1 }))
    .sort((a, b) => a.score_pct - b.score_pct || (a.time_seconds ?? 1e9) - (b.time_seconds ?? 1e9) || a.handle.localeCompare(b.handle))
    .slice(0, opts.limit ?? 50)
    .map((row, index) => ({ ...row, rank: index + 1 }));
  return {
    as_of: new Date().toISOString(),
    rules: "Each handle's best two-minute round. Score: the average of how far each store's final price sits above its secret lowest price. Lower wins; time breaks ties. Handles are not verified.",
    rounds: fair.filter((row) => !row.internal).length,
    lab_rounds: fair.filter((row) => row.internal).length,
    rows: ranked,
  };
}

/** Totals for the experiment page. Outside rounds only. */
export async function practiceTotals(store: Store) {
  if (store.kind === "unavailable") return { rounds: 0, closed: 0, handles: 0, messages: 0 };
  const opened = await store.select("SELECT public FROM events WHERE type = 'ring.opened' AND internal = 0");
  const closed = await store.select("SELECT COUNT(*) AS n FROM events WHERE type = 'ring.closed' AND internal = 0");
  const messages = await store.select("SELECT COUNT(*) AS n FROM events WHERE type = 'ring.message' AND internal = 0");
  const handles = new Set(
    opened
      .map((row) => (typeof row.public === "string" ? JSON.parse(row.public) : row.public) as Record<string, unknown>)
      .map((pub) => pub.handle)
      .filter((handle): handle is string => typeof handle === "string"),
  );
  return { rounds: opened.length, closed: Number(closed[0]?.n ?? 0), handles: handles.size, messages: Number(messages[0]?.n ?? 0) };
}

export function describeStores() {
  return RING_STORES.map((store) => ({ id: store.id, name: store.name, paddle: store.no, temper: store.temper, how_it_haggles: store.style }));
}

export { clock as ringClock, type Move };
