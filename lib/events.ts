import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { agentFromRequest, type AgentInfo } from "./agents.js";
import type { Statement, Store } from "./db.js";
import { defaultOrigin, requestOrigin } from "./origin.js";
import { hashClient } from "./rate-limit.js";

/**
 * THE EVENT LOG (docs/DATA.md). One append-only table, `events`. Every action writes its event in
 * the same transaction as the action (Store.batch / saveRequest's `also`). Pages, counts and the
 * auction are built from it.
 *
 * Each row has `public` JSON (safe on any public surface after it goes through lib/stream.ts or
 * lib/stats.ts, which pick fields by name) and `private` JSON (held orders, caps, bid amounts,
 * floors, reasons). Private JSON is read only by the poster's token view and the export script.
 */
export type EventType =
  | "request.posted"
  | "request.holding"
  | "store.matched"
  | "store.read"
  | "offer.made"
  | "lead.changed"
  | "auction.closed"
  | "outcome.reported"
  | "store.notified"
  | "store.claimed"
  | "store.rule_set"
  | "page.read";

export type Channel = "api" | "mcp" | "find" | "web" | "worker" | "service";

/** Who caused an action. Built once per HTTP request. Never holds a raw IP. */
export type EventContext = {
  agent: AgentInfo;
  internal: boolean;
  /** Salted HMAC of the client IP (same salt as the rate limit). Cleared after 30 days. */
  caller_hash: string | null;
  channel: Channel;
};

export type EventRow = {
  id: string;
  at: string;
  type: EventType;
  request_id: string | null;
  store_domain: string | null;
  agent_class: string;
  internal: boolean;
  public: Record<string, unknown>;
  private: Record<string, unknown>;
};

export type NewEvent = {
  type: EventType;
  /** Defaults to a random UUID. Pass a fixed id to make a write idempotent (auction.closed). */
  id?: string;
  at?: string;
  request_id?: string | null;
  store_domain?: string | null;
  public?: Record<string, unknown>;
  private?: Record<string, unknown>;
  /** Overrides the context: events made by the watcher inherit the request's internal flag. */
  internal?: boolean;
  agent_class?: string;
};

const INSERT = `INSERT INTO events (id, at, type, request_id, store_domain, agent_class, internal, public, private, caller_hash)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const INSERT_ONCE = `${INSERT} ON CONFLICT(id) DO NOTHING`;

/** Comma-separated keys in HB_INTERNAL_KEYS. A caller sending one in X-HaggleBoard-Internal-Key is ours. */
export function internalKeyMatches(sent: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = sent?.trim();
  if (!value) return false;
  const digest = createHash("sha256").update(value).digest();
  return (env.HB_INTERNAL_KEYS ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length >= 16)
    .some((key) => timingSafeEqual(createHash("sha256").update(key).digest(), digest));
}

/**
 * internal is true when the request is not from outside (lib/origin.ts: tests, localhost, .test
 * hosts, X-HaggleBoard-Origin, a HaggleBoard- user agent) or carries an internal key.
 */
export function eventContext(req: Request | null, channel: Channel, env: NodeJS.ProcessEnv = process.env): EventContext {
  const origin = req ? requestOrigin(req, env) : defaultOrigin(env);
  const keyed = req ? internalKeyMatches(req.headers.get("x-haggleboard-internal-key"), env) : false;
  let caller_hash: string | null = null;
  if (req) {
    try {
      caller_hash = hashClient(req, env);
    } catch {
      caller_hash = null;
    }
  }
  return { agent: agentFromRequest(req), internal: origin !== "outside" || keyed, caller_hash, channel };
}

/** For direct service calls and CLI scripts: our own traffic. */
export function serviceContext(channel: Channel = "service", env: NodeJS.ProcessEnv = process.env): EventContext {
  return eventContext(null, channel, env);
}

export function eventStatement(event: NewEvent, ctx: EventContext | null): Statement {
  const row = [
    event.id ?? randomUUID(),
    event.at ?? new Date().toISOString(),
    event.type,
    event.request_id ?? null,
    event.store_domain ?? null,
    event.agent_class ?? ctx?.agent.agent_class ?? "haggleboard",
    (event.internal ?? ctx?.internal ?? true) ? 1 : 0,
    JSON.stringify(event.public ?? {}),
    JSON.stringify(event.private ?? {}),
    ctx?.caller_hash ?? null,
  ];
  return [event.id ? INSERT_ONCE : INSERT, row];
}

/** Writes events alone (when the action has no row of its own, such as a page read). */
export async function writeEvents(store: Store, events: NewEvent[], ctx: EventContext | null): Promise<void> {
  if (store.kind === "unavailable" || events.length === 0) return;
  await store.batch(events.map((event) => eventStatement(event, ctx)));
}

function parseJson(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value === "object") return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function asEvent(row: Record<string, unknown>): EventRow {
  return {
    id: String(row.id),
    at: String(row.at),
    type: String(row.type) as EventType,
    request_id: row.request_id == null ? null : String(row.request_id),
    store_domain: row.store_domain == null ? null : String(row.store_domain),
    agent_class: String(row.agent_class),
    internal: Number(row.internal) === 1,
    public: parseJson(row.public),
    private: parseJson(row.private),
  };
}

const COLUMNS = "id, at, type, request_id, store_domain, agent_class, internal, public, private";

export async function requestEvents(store: Store, requestId: string): Promise<EventRow[]> {
  if (store.kind === "unavailable") return [];
  return (await store.select(`SELECT ${COLUMNS} FROM events WHERE request_id = ? ORDER BY at ASC, id ASC`, [requestId])).map(asEvent);
}

export async function eventsOfType(
  store: Store,
  type: EventType,
  opts: { since?: string; includeInternal?: boolean; limit?: number } = {},
): Promise<EventRow[]> {
  if (store.kind === "unavailable") return [];
  const where = ["type = ?"];
  const params: unknown[] = [type];
  if (opts.since) {
    where.push("at >= ?");
    params.push(opts.since);
  }
  if (!opts.includeInternal) where.push("internal = 0");
  params.push(opts.limit ?? 100_000);
  return (
    await store.select(`SELECT ${COLUMNS} FROM events WHERE ${where.join(" AND ")} ORDER BY at ASC, id ASC LIMIT ?`, params)
  ).map(asEvent);
}

/** Whether a request's own events are internal. Falls back to true (never count unknown traffic). */
export async function requestIsInternal(store: Store, requestId: string, fallback = true): Promise<boolean> {
  if (store.kind === "unavailable") return fallback;
  const row = (await store.select("SELECT internal FROM events WHERE request_id = ? AND type = 'request.posted' LIMIT 1", [requestId]))[0];
  return row ? Number(row.internal) === 1 : fallback;
}

/** Page through the whole table in (at, id) order. Used by the export script. */
export async function* allEvents(store: Store, pageSize = 1000): AsyncGenerator<Record<string, unknown>> {
  let after: [string, string] | null = null;
  for (;;) {
    const rows: Record<string, unknown>[] = after
      ? await store.select(
          `SELECT ${COLUMNS} FROM events WHERE at > ? OR (at = ? AND id > ?) ORDER BY at ASC, id ASC LIMIT ?`,
          [after[0], after[0], after[1], pageSize],
        )
      : await store.select(`SELECT ${COLUMNS} FROM events ORDER BY at ASC, id ASC LIMIT ?`, [pageSize]);
    if (rows.length === 0) return;
    for (const row of rows) {
      const event = asEvent(row);
      yield { ...event };
    }
    const last = rows[rows.length - 1]!;
    after = [String(last.at), String(last.id)];
  }
}
