import type { Store } from "./db.js";
import { publicNeed } from "./privacy.js";
import { publicStats } from "./stats.js";
import { publicStream, type PublicStream } from "./stream.js";
import { normalizeStoredNeed } from "../referee/parse.js";
import type { ResolvedNeed } from "../referee/types.js";

/**
 * Real numbers for the homepage strip and the board. Built from public fields only, and only from
 * requests that came from outside: tests, localhost and our own tools (origin "test" or "internal")
 * never show up as activity.
 */

export type LiveRow = {
  id: string;
  url: string;
  created_at: string;
  label: string;
  status: PublicStream["status"];
  seconds_left: number;
  stores: number;
  winner: string | null;
  band_label: string | null;
};

export async function liveRow(store: Store, row: { id: string; created_at: string; need_json: string }, now = Date.now()): Promise<LiveRow> {
  const need = publicNeed(normalizeStoredNeed(JSON.parse(row.need_json) as Partial<ResolvedNeed>));
  const stream = await publicStream(store, row.id, now);
  const events = stream?.events ?? [];
  const closed = events.find((event) => event.type === "auction.closed");
  return {
    id: row.id,
    url: `/r/${row.id}`,
    created_at: row.created_at,
    label: need.label,
    status: stream?.status ?? "no_auction",
    seconds_left: stream?.seconds_left ?? 0,
    stores: events.filter((event) => event.type === "store.joined").length,
    winner: closed && closed.type === "auction.closed" ? (closed.winner?.store.replace(/^www\./, "") ?? null) : null,
    band_label: closed && closed.type === "auction.closed" ? closed.band_label : null,
  };
}

/** The most recent requests from outside callers, newest first. */
export async function latestOutsideRequests(store: Store, limit = 5, now = Date.now()): Promise<LiveRow[]> {
  if (store.kind === "unavailable") return [];
  const rows = (await store.listRequests(50)).filter((row) => (row.origin ?? "outside") === "outside").slice(0, limit);
  return Promise.all(rows.map((row) => liveRow(store, row, now)));
}

export type HomeLive = {
  stored: boolean;
  requests: number;
  stores: number;
  closed: number;
  beat: number;
  closedWithWinner: number;
  asOf: string;
  latest: LiveRow[];
};

export async function homeLive(store: Store, now = Date.now()): Promise<HomeLive> {
  const asOf = new Date(now).toISOString();
  if (store.kind === "unavailable") {
    return { stored: false, requests: 0, stores: 0, closed: 0, beat: 0, closedWithWinner: 0, asOf, latest: [] };
  }
  const stats = await publicStats(store, now);
  return {
    stored: true,
    requests: stats.requests.value ?? 0,
    stores: stats.stores_answering.value ?? 0,
    closed: stats.auctions_closed.value ?? 0,
    beat: stats.winner_beat_best_public_price.beat,
    closedWithWinner: stats.winner_beat_best_public_price.closed_with_winner,
    asOf,
    latest: await latestOutsideRequests(store, 5, now),
  };
}
