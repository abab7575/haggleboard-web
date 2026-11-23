import type { Store } from "../db.js";
import { RING_WINDOW_SECONDS } from "./cast.js";
import { roundState, type RingState } from "./service.js";

export type ReplayMeta = {
  lot: number;
  item: string;
  ticket_cents: number;
  window_seconds: number;
  handle: string | null;
  label: string;
  closed_at: number | null;
};

export function replayOf(state: RingState, label: string) {
  return {
    meta: {
      lot: state.lot,
      item: state.item,
      ticket_cents: state.ticket_cents,
      window_seconds: state.window_seconds,
      handle: state.handle,
      label,
      closed_at: state.status === "closed" ? state.window_seconds : null,
    } satisfies ReplayMeta,
    rows: state.log,
  };
}

/** The latest finished round an outside agent played with a handle, to replay on the home page. Null until there is one. */
export async function latestReplay(store: Store) {
  if (store.kind === "unavailable") return null;
  const rows = await store.select(
    "SELECT request_id, public FROM events WHERE type = 'ring.closed' AND internal = 0 ORDER BY at DESC LIMIT 20",
  );
  for (const row of rows) {
    const pub = (typeof row.public === "string" ? JSON.parse(row.public) : row.public) as Record<string, unknown>;
    if (Number(pub.window_seconds) !== RING_WINDOW_SECONDS || typeof pub.handle !== "string") continue;
    const state = await roundState(String(row.request_id), { store });
    return replayOf(state, `A real round by ${pub.handle}, replayed. Made-up stores, play money.`);
  }
  return null;
}
