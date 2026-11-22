import type { Statement, Store } from "./db.js";
import type { CatalogVariant } from "../referee/types.js";

/** SQL for the watcher tables. Works on SQLite, Postgres and PGlite through Store.exec/select. */

export type WatchStoreResult = {
  store_domain: string;
  source: "brand" | "arc" | "seed";
  status: "answered" | "no_match" | "skipped";
  /** Why a store was skipped or had no match. Plain words, no private data. */
  reason: string | null;
  checkout_route_known: boolean | null;
  matched: number;
  fetches: number;
};

export type WatchSummary = {
  stores: WatchStoreResult[];
  store_fetches: number;
  arc_calls: number;
  stopped: string | null;
};

export type WatchRun = {
  request_id: string;
  status: "running" | "done";
  started_at: string;
  finished_at: string | null;
  summary: WatchSummary | null;
};

export async function getWatchRun(store: Store, requestId: string): Promise<WatchRun | null> {
  if (store.kind === "unavailable") return null;
  const row = (await store.select("SELECT request_id, status, started_at, finished_at, summary_json FROM watch_runs WHERE request_id = ?", [requestId]))[0];
  if (!row) return null;
  return {
    request_id: String(row.request_id),
    status: row.status === "done" ? "done" : "running",
    started_at: String(row.started_at),
    finished_at: row.finished_at == null ? null : String(row.finished_at),
    summary: row.summary_json ? (JSON.parse(String(row.summary_json)) as WatchSummary) : null,
  };
}

export async function listWatchRuns(store: Store, requestIds: string[]): Promise<Map<string, WatchRun>> {
  const out = new Map<string, WatchRun>();
  for (const id of requestIds) {
    const run = await getWatchRun(store, id);
    if (run) out.set(id, run);
  }
  return out;
}

/** Claims a request for one watch run. False when another run already has it. */
export async function claimWatchRun(store: Store, requestId: string, now: string): Promise<boolean> {
  const existing = await getWatchRun(store, requestId);
  if (existing) return false;
  try {
    await store.exec("INSERT INTO watch_runs (request_id, status, started_at) VALUES (?, 'running', ?)", [requestId, now]);
    return true;
  } catch {
    return false;
  }
}

export async function finishWatchRun(store: Store, requestId: string, summary: WatchSummary, now: string): Promise<void> {
  await store.exec("UPDATE watch_runs SET status = 'done', finished_at = ?, summary_json = ? WHERE request_id = ?", [
    now,
    JSON.stringify(summary),
    requestId,
  ]);
}

export function watchOfferStatements(requestId: string, variants: CatalogVariant[]): Statement[] {
  return variants.map((variant) => [
    `INSERT INTO watch_offers (id, request_id, store_domain, variant_json, observed_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET variant_json = excluded.variant_json, observed_at = excluded.observed_at`,
    [`${requestId}:${variant.id}`, requestId, variant.store_domain, JSON.stringify(variant), variant.observed_at],
  ]);
}

export async function saveWatchOffers(store: Store, requestId: string, variants: CatalogVariant[]): Promise<void> {
  await store.batch(watchOfferStatements(requestId, variants));
}

export async function listWatchOffers(store: Store, requestIds: string[]): Promise<Map<string, CatalogVariant[]>> {
  const out = new Map<string, CatalogVariant[]>();
  if (store.kind === "unavailable") return out;
  for (const id of requestIds) {
    const rows = await store.select("SELECT variant_json FROM watch_offers WHERE request_id = ?", [id]);
    out.set(
      id,
      rows.flatMap((row) => {
        try {
          return [JSON.parse(String(row.variant_json)) as CatalogVariant];
        } catch {
          return [];
        }
      }),
    );
  }
  return out;
}

export type FetchState = { last_fetch_at: string | null; backoff_until: string | null; backoff_reason: string | null };

export async function getFetchState(store: Store, domain: string): Promise<FetchState> {
  const row = (await store.select("SELECT last_fetch_at, backoff_until, backoff_reason FROM store_fetch_state WHERE store_domain = ?", [domain]))[0];
  return {
    last_fetch_at: row?.last_fetch_at == null ? null : String(row.last_fetch_at),
    backoff_until: row?.backoff_until == null ? null : String(row.backoff_until),
    backoff_reason: row?.backoff_reason == null ? null : String(row.backoff_reason),
  };
}

export async function recordFetch(
  store: Store,
  domain: string,
  at: string,
  backoff: { until: string; reason: string } | null,
): Promise<void> {
  await store.batch([recordFetchStatement(domain, at, backoff)]);
}

export function recordFetchStatement(domain: string, at: string, backoff: { until: string; reason: string } | null): Statement {
  return [
    `INSERT INTO store_fetch_state (store_domain, last_fetch_at, backoff_until, backoff_reason) VALUES (?, ?, ?, ?)
     ON CONFLICT(store_domain) DO UPDATE SET
       last_fetch_at = excluded.last_fetch_at,
       backoff_until = COALESCE(excluded.backoff_until, store_fetch_state.backoff_until),
       backoff_reason = COALESCE(excluded.backoff_reason, store_fetch_state.backoff_reason)`,
    [domain, at, backoff?.until ?? null, backoff?.reason ?? null],
  ];
}

/** Requests the worker should watch: recent, not hidden, not yet watched. */
export async function pendingWatchRequests(store: Store, since: string, limit: number): Promise<string[]> {
  const rows = await store.select(
    `SELECT r.id AS id FROM requests r
     LEFT JOIN watch_runs w ON w.request_id = r.id
     WHERE w.request_id IS NULL AND r.hidden_at IS NULL AND r.created_at >= ?
     ORDER BY r.created_at ASC LIMIT ?`,
    [since, limit],
  );
  return rows.map((row) => String(row.id));
}
