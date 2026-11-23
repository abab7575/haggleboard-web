import { CLOSE_GRACE_MS, eventsWithLazyClose, type Band } from "./auction.js";
import type { Store } from "./db.js";
import { eventsOfType, type EventRow } from "./events.js";
import { practiceTotals } from "./ring/service.js";

/**
 * Public aggregates, built from the event log only. Internal traffic (tests, our own tools,
 * HB_INTERNAL_KEYS) is left out of every number. Every number comes with the count behind it and
 * the time it was computed. Nothing here is estimated or seeded: an empty log gives zeros.
 */

const DAY = 86_400_000;

/** Closes any auction whose deadline has passed and was never read since. Bounded per call. */
export async function closeOverdueAuctions(store: Store, now = Date.now(), limit = 200): Promise<number> {
  if (store.kind === "unavailable") return 0;
  const since = new Date(now - 30 * DAY).toISOString();
  const rows = await store.select(
    `SELECT p.request_id AS request_id, p.public AS public FROM events p
     LEFT JOIN events c ON c.id = p.request_id || ':auction.closed'
     WHERE p.type = 'request.posted' AND p.at >= ? AND c.id IS NULL
     ORDER BY p.at ASC LIMIT ?`,
    [since, limit],
  );
  let closed = 0;
  for (const row of rows) {
    let deadline: string | null = null;
    try {
      const pub = typeof row.public === "string" ? (JSON.parse(row.public) as { deadline?: unknown }) : (row.public as { deadline?: unknown });
      deadline = typeof pub?.deadline === "string" ? pub.deadline : null;
    } catch {
      deadline = null;
    }
    if (!deadline || Date.parse(deadline) + CLOSE_GRACE_MS > now) continue;
    await eventsWithLazyClose(store, String(row.request_id), { now });
    closed += 1;
  }
  return closed;
}

export type Metric = { value: number | null; count: number; as_of: string };

function metric(value: number | null, count: number, asOf: string): Metric {
  return { value, count, as_of: asOf };
}

export async function publicStats(store: Store, now = Date.now()) {
  await closeOverdueAuctions(store, now);
  const asOf = new Date(now).toISOString();
  const posted = await eventsOfType(store, "request.posted");
  const offers = await eventsOfType(store, "offer.made");
  const closed = await eventsOfType(store, "auction.closed");
  const classes = new Map<string, number>();
  for (const event of posted) classes.set(event.agent_class, (classes.get(event.agent_class) ?? 0) + 1);
  const stores = new Set(offers.map((event) => event.store_domain).filter(Boolean));
  // A close whose best offer was never confirmed during the auction is not a win (lib/auction.ts).
  const lastSeen = closed.filter((event) => event.public.winner != null && event.public.result === "last_seen");
  const withWinner = closed.filter((event) => event.public.winner != null && event.public.result !== "last_seen");
  const beat = withWinner.filter((event) => event.public.beat_public === true).length;
  const outcomes = await eventsOfType(store, "outcome.reported");
  const rules = await eventsOfType(store, "store.rule_set");
  const latestOutcome = new Map<string, string>();
  for (const event of outcomes) if (event.request_id) latestOutcome.set(event.request_id, String(event.public.outcome));
  const winnerIds = new Set(withWinner.map((event) => event.request_id));
  const boughtThere = [...latestOutcome.entries()].filter(([id, outcome]) => winnerIds.has(id) && outcome === "bought_at_winner").length;
  const ruleStores = new Set(rules.map((event) => event.store_domain).filter(Boolean));
  const handles = new Set(posted.map((event) => event.public.handle).filter((handle) => typeof handle === "string"));
  const practice = await practiceTotals(store);
  return {
    as_of: asOf,
    since: posted[0]?.at ?? null,
    note: "Outside traffic only: tests and our own tools are excluded. Each number has the count behind it.",
    requests: metric(posted.length, posted.length, asOf),
    agent_classes: {
      ...metric(classes.size, posted.length, asOf),
      by_class: [...classes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([agent_class, count]) => ({ agent_class, count })),
    },
    stores_answering: metric(stores.size, offers.length, asOf),
    auctions_closed: metric(closed.length, closed.length, asOf),
    /** Closes where no offer was confirmed live: "best last-seen price, not confirmed today". Not wins. */
    auctions_last_seen_only: metric(lastSeen.length, closed.length, asOf),
    winner_beat_best_public_price: {
      ...metric(withWinner.length ? beat / withWinner.length : null, withWinner.length, asOf),
      beat,
      closed_with_winner: withWinner.length,
    },
    /** What users have allowed their agents to do, as the agents said it. Totals only, never per person. */
    allowed: allowedTotals(posted, asOf),
    /** The experiment's six links (docs/EXPERIMENT.md), counted from the same outside-only log. */
    experiment: {
      link1_agents_ask: { real_posts: metric(posted.length, posted.length, asOf), named_agents: metric(handles.size, posted.length, asOf), agent_classes: metric(classes.size, posted.length, asOf) },
      link2_stores_answer: {
        stores_with_rule: metric(ruleStores.size, rules.length, asOf),
        beat_best_public_price: metric(withWinner.length ? beat / withWinner.length : null, withWinner.length, asOf),
      },
      link3_shopper_takes_it: metric(withWinner.length ? boughtThere / withWinner.length : null, withWinner.length, asOf),
      link4_brand_ahead: { status: "not measurable yet", note: "Needs stores to tell us what they kept." },
      link5_customer_returns: { status: "not measurable yet", note: "Needs stores to tell us about reorders." },
      link6_relationship_bids: { status: "not built" },
    },
    /** The practice ring, counted apart. Never part of any number above. */
    practice: {
      note: "Practice rounds with made-up stores and play money. Outside rounds only; our own lab runs are left out.",
      rounds: metric(practice.rounds, practice.rounds, asOf),
      rounds_finished: metric(practice.closed, practice.rounds, asOf),
      named_agents: metric(practice.handles, practice.rounds, asOf),
    },
  };
}

/** Medians are only published once at least this many limits back them, so no one person's limit shows. */
export const ALLOWED_MIN_FOR_MEDIAN = 5;

export function allowedTotals(posted: EventRow[], asOf: string) {
  const kinds = { ask_first: 0, under_limit: 0, just_buy: 0 };
  const limits = new Map<string, number[]>();
  let told = 0;
  for (const event of posted) {
    const allowed = event.private.allowed as { kind?: string; limit?: number | null; currency?: string | null } | undefined;
    if (!allowed || !allowed.kind || !(allowed.kind in kinds)) continue;
    told += 1;
    kinds[allowed.kind as keyof typeof kinds] += 1;
    if (allowed.kind === "under_limit" && typeof allowed.limit === "number" && allowed.currency) {
      const list = limits.get(allowed.currency) ?? [];
      list.push(allowed.limit);
      limits.set(allowed.currency, list);
    }
  }
  return {
    note: "Only what agents chose to tell us. Totals only.",
    told: metric(told, posted.length, asOf),
    ask_first: metric(kinds.ask_first, told, asOf),
    under_limit: metric(kinds.under_limit, told, asOf),
    just_buy: metric(kinds.just_buy, told, asOf),
    median_limit: [...limits.entries()]
      .filter(([, list]) => list.length >= ALLOWED_MIN_FOR_MEDIAN)
      .map(([currency, list]) => {
        const sorted = [...list].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
        return { currency, ...metric(median, sorted.length, asOf) };
      }),
  };
}

/** Per-agent scorecard for a public handle. Bands only, never amounts. */
export async function agentScorecard(store: Store, handle: string, now = Date.now()) {
  await closeOverdueAuctions(store, now);
  const posted = (await eventsOfType(store, "request.posted")).filter((event) => event.public.handle === handle);
  if (posted.length === 0) return null;
  const ids = new Set(posted.map((event) => event.request_id));
  const closed = (await eventsOfType(store, "auction.closed")).filter((event) => ids.has(event.request_id));
  const outcomes = latestPerRequest((await eventsOfType(store, "outcome.reported")).filter((event) => ids.has(event.request_id)));
  const wins = closed.filter((event) => event.public.beat_public === true && event.public.result !== "last_seen");
  const bands = new Map<string, number>();
  for (const event of closed) {
    const band = (event.public.band as Band | null) ?? "no_offer";
    bands.set(band, (bands.get(band) ?? 0) + 1);
  }
  const count = (name: string) => outcomes.filter((event) => event.public.outcome === name).length;
  return {
    handle,
    as_of: new Date(now).toISOString(),
    first_post: posted[0]!.at,
    last_post: posted[posted.length - 1]!.at,
    requests: posted.length,
    auctions_closed: closed.length,
    beat_best_public_price: wins.length,
    result_bands: [...bands.entries()].map(([band, n]) => ({ band, count: n })),
    outcomes_reported: {
      count: outcomes.length,
      bought_at_winner: count("bought_at_winner"),
      bought_elsewhere: count("bought_elsewhere"),
      did_not_buy: count("did_not_buy"),
    },
    note: "Built from requests posted with this handle by outside callers. Handles are not verified: anyone can post under any handle.",
  };
}

function latestPerRequest(events: EventRow[]): EventRow[] {
  const latest = new Map<string, EventRow>();
  for (const event of events) if (event.request_id) latest.set(event.request_id, event);
  return [...latest.values()];
}
