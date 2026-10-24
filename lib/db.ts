import { mkdirSync } from "node:fs";
import path from "node:path";
import type { CatalogVariant } from "../referee/types.js";

export class StoreUnavailableError extends Error {
  constructor() {
    super("No database is configured");
    this.name = "StoreUnavailableError";
  }
}

export type RequestRow = {
  id: string;
  need_json: string;
  created_at: string;
  delete_token_hmac: string | null;
};
export type BidRow = {
  id: string;
  request_id: string | null;
  store_domain: string;
  bid_json: string;
  created_at: string;
};
export type StoreKeyRow = { store_domain: string; key_hmac: string; created_at: string };
export type ReportRow = {
  id: string;
  request_id: string;
  ip_hash: string;
  reason: string | null;
  created_at: string;
};
export type VariantRow = {
  id: string;
  store_domain: string;
  brand: string;
  model: string;
  gender: string;
  size: string | null;
  price_cents: number;
  currency: string;
  available: number;
  variant_json: string;
  observed_at: string;
};

export type Store = {
  kind: "sqlite" | "postgres" | "unavailable";
  saveRequest: (row: RequestRow) => Promise<void>;
  getRequest: (id: string) => Promise<RequestRow | null>;
  listRequests: (limit: number) => Promise<RequestRow[]>;
  saveBid: (row: BidRow & { key_hash: string }) => Promise<void>;
  listBids: () => Promise<BidRow[]>;
  saveStoreKey: (row: StoreKeyRow) => Promise<void>;
  getStoreKey: (domain: string) => Promise<string | null>;
  hideRequest: (id: string, hiddenAt: string, hiddenBy: "token" | "reports") => Promise<void>;
  countAutoHidesSince: (since: string) => Promise<number>;
  countReporters: (requestId: string) => Promise<number>;
  hasReport: (requestId: string, ipHash: string) => Promise<boolean>;
  bumpRate: (ipHash: string, windowKey: string) => Promise<number>;
  saveReport: (row: ReportRow) => Promise<void>;
  listReports: () => Promise<ReportRow[]>;
  upsertVariants: (rows: VariantRow[]) => Promise<void>;
  listVariants: () => Promise<CatalogVariant[]>;
  countVariants: () => Promise<number>;
  latestObserved: () => Promise<string | null>;
  close: () => Promise<void>;
};

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    need_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    hidden_at TEXT,
    hidden_by TEXT,
    delete_token_hmac TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS bids (
    id TEXT PRIMARY KEY,
    request_id TEXT,
    store_domain TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    bid_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS variants (
    id TEXT PRIMARY KEY,
    store_domain TEXT NOT NULL,
    brand TEXT NOT NULL,
    model TEXT NOT NULL,
    gender TEXT NOT NULL,
    size TEXT,
    price_cents INTEGER NOT NULL,
    currency TEXT NOT NULL,
    available INTEGER NOT NULL,
    variant_json TEXT NOT NULL,
    observed_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_variants_brand ON variants (brand)`,
  `CREATE INDEX IF NOT EXISTS idx_bids_request ON bids (request_id)`,
  `CREATE TABLE IF NOT EXISTS store_keys (
    store_domain TEXT PRIMARY KEY,
    key_hmac TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    ip_hash TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rate_hits (
    ip_hash TEXT NOT NULL,
    window_key TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (ip_hash, window_key)
  )`,
];

const UPSERT_VARIANT = `INSERT INTO variants (
  id, store_domain, brand, model, gender, size, price_cents, currency, available, variant_json, observed_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  store_domain = excluded.store_domain,
  brand = excluded.brand,
  model = excluded.model,
  gender = excluded.gender,
  size = excluded.size,
  price_cents = excluded.price_cents,
  currency = excluded.currency,
  available = excluded.available,
  variant_json = excluded.variant_json,
  observed_at = excluded.observed_at`;

const UPSERT_REQUEST = `INSERT INTO requests (id, need_json, created_at, delete_token_hmac) VALUES (?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  need_json = excluded.need_json,
  created_at = excluded.created_at,
  delete_token_hmac = COALESCE(requests.delete_token_hmac, excluded.delete_token_hmac)`;

const SELECT_REQUEST = `SELECT id, need_json, created_at, delete_token_hmac FROM requests WHERE id = ? AND hidden_at IS NULL`;
const LIST_REQUESTS = `SELECT id, need_json, created_at, delete_token_hmac FROM requests WHERE hidden_at IS NULL ORDER BY created_at DESC LIMIT ?`;
const HIDE_REQUEST = `UPDATE requests SET hidden_at = ?, hidden_by = ? WHERE id = ? AND hidden_at IS NULL`;
const COUNT_AUTO_HIDES = `SELECT COUNT(*) AS n FROM requests WHERE hidden_by = 'reports' AND hidden_at >= ?`;
const COUNT_REPORTERS = `SELECT COUNT(DISTINCT ip_hash) AS n FROM reports WHERE request_id = ?`;
const HAS_REPORT = `SELECT 1 AS n FROM reports WHERE request_id = ? AND ip_hash = ? LIMIT 1`;
const BUMP_RATE = `INSERT INTO rate_hits (ip_hash, window_key, count) VALUES (?, ?, 1)
ON CONFLICT(ip_hash, window_key) DO UPDATE SET count = rate_hits.count + 1
RETURNING count`;

const UPSERT_BID = `INSERT INTO bids (id, request_id, store_domain, key_hash, bid_json, created_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  request_id = excluded.request_id,
  store_domain = excluded.store_domain,
  key_hash = excluded.key_hash,
  bid_json = excluded.bid_json,
  created_at = excluded.created_at`;

const UPSERT_STORE_KEY = `INSERT INTO store_keys (store_domain, key_hmac, created_at) VALUES (?, ?, ?)
ON CONFLICT(store_domain) DO UPDATE SET key_hmac = excluded.key_hmac, created_at = excluded.created_at`;

const INSERT_REPORT = `INSERT INTO reports (id, request_id, ip_hash, reason, created_at) VALUES (?, ?, ?, ?, ?)`;

export function sqlPlaceholders(sql: string, dialect: "sqlite" | "postgres"): string {
  if (dialect === "sqlite") return sql;
  let i = 0;
  return sql.replace(/\?/g, () => {
    i += 1;
    return `$${i}`;
  });
}

export function unavailableStore(): Store {
  return {
    kind: "unavailable",
    async saveRequest() {
      throw new StoreUnavailableError();
    },
    async getRequest() {
      return null;
    },
    async listRequests() {
      return [];
    },
    async saveBid() {
      throw new StoreUnavailableError();
    },
    async listBids() {
      return [];
    },
    async saveStoreKey() {
      throw new StoreUnavailableError();
    },
    async getStoreKey() {
      return null;
    },
    async hideRequest() {
      throw new StoreUnavailableError();
    },
    async countAutoHidesSince() {
      return 0;
    },
    async countReporters() {
      return 0;
    },
    async hasReport() {
      return false;
    },
    async bumpRate() {
      throw new StoreUnavailableError();
    },
    async saveReport() {
      throw new StoreUnavailableError();
    },
    async listReports() {
      return [];
    },
    async upsertVariants() {
      throw new StoreUnavailableError();
    },
    async listVariants() {
      return [];
    },
    async countVariants() {
      return 0;
    },
    async latestObserved() {
      return null;
    },
    async close() {},
  };
}

export async function openStore(env: NodeJS.ProcessEnv = process.env): Promise<Store> {
  const url = env.DATABASE_URL?.trim();
  try {
    if (url) {
      if (/^postgres(?:ql)?:\/\//i.test(url)) return await openPostgres(url);
      if (url === ":memory:" || url.startsWith("file:")) return openSqlite(sqlitePath(url));
      throw new Error("DATABASE_URL must be a postgres connection string or a file: SQLite path");
    }
    if (env.VERCEL) return unavailableStore();
    return openSqlite(path.join(process.cwd(), "data", "haggleboard.sqlite"));
  } catch (error) {
    if (error instanceof StoreUnavailableError) return unavailableStore();
    if (env.VERCEL) return unavailableStore();
    throw error;
  }
}

export async function openSqlite(filename: string): Promise<Store> {
  if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true });
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(filename);
  if (filename !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  for (const statement of STATEMENTS) db.exec(statement);
  migrateSqliteRequests(db);

  const run = (query: string, params: unknown[] = []) => {
    db.prepare(query).run(...(params as never[]));
  };
  const all = (query: string, params: unknown[] = []) =>
    db.prepare(query).all(...(params as never[])) as Record<string, unknown>[];

  return {
    kind: "sqlite",
    async saveRequest(row) {
      run(UPSERT_REQUEST, [row.id, row.need_json, row.created_at, row.delete_token_hmac]);
    },
    async getRequest(id) {
      return oneRequest(all(SELECT_REQUEST, [id]));
    },
    async listRequests(limit) {
      return all(LIST_REQUESTS, [limit]).map(asRequest);
    },
    async saveBid(row) {
      run(UPSERT_BID, [row.id, row.request_id, row.store_domain, row.key_hash, row.bid_json, row.created_at]);
    },
    async listBids() {
      return all(
        "SELECT id, request_id, store_domain, bid_json, created_at FROM bids ORDER BY created_at ASC",
      ).map(asBid);
    },
    async saveStoreKey(row) {
      run(UPSERT_STORE_KEY, [row.store_domain, row.key_hmac, row.created_at]);
    },
    async getStoreKey(domain) {
      const value = all("SELECT key_hmac FROM store_keys WHERE store_domain = ?", [domain])[0]?.key_hmac;
      return typeof value === "string" ? value : null;
    },
    async hideRequest(id, hiddenAt, hiddenBy) {
      run(HIDE_REQUEST, [hiddenAt, hiddenBy, id]);
    },
    async countAutoHidesSince(since) {
      return Number(all(COUNT_AUTO_HIDES, [since])[0]?.n ?? 0);
    },
    async countReporters(requestId) {
      return Number(all(COUNT_REPORTERS, [requestId])[0]?.n ?? 0);
    },
    async hasReport(requestId, ipHash) {
      return all(HAS_REPORT, [requestId, ipHash]).length > 0;
    },
    async bumpRate(ipHash, windowKey) {
      return Number(all(BUMP_RATE, [ipHash, windowKey])[0]?.count ?? 0);
    },
    async saveReport(row) {
      run(INSERT_REPORT, [row.id, row.request_id, row.ip_hash, row.reason, row.created_at]);
    },
    async listReports() {
      return all("SELECT id, request_id, ip_hash, reason, created_at FROM reports ORDER BY created_at ASC").map(asReport);
    },
    async upsertVariants(rows) {
      if (rows.length === 0) return;
      const stmt = db.prepare(UPSERT_VARIANT);
      const tx = db.transaction((batch: VariantRow[]) => {
        for (const row of batch) stmt.run(...variantParams(row));
      });
      tx(rows);
    },
    async listVariants() {
      return all("SELECT variant_json FROM variants").flatMap(parseVariant);
    },
    async countVariants() {
      return Number(all("SELECT COUNT(*) AS n FROM variants")[0]?.n ?? 0);
    },
    async latestObserved() {
      const value = all("SELECT MAX(observed_at) AS observed_at FROM variants")[0]?.observed_at;
      return typeof value === "string" ? value : null;
    },
    async close() {
      db.close();
    },
  };
}

async function openPostgres(url: string): Promise<Store> {
  const postgres = (await import("postgres")).default;
  const local = /@(localhost|127\.0\.0\.1)(?::|\/|$)/.test(url);
  const sql = postgres(url, {
    max: 1,
    ssl: local ? false : "require",
    idle_timeout: 20,
    connect_timeout: 15,
  });
  for (const statement of STATEMENTS) await sql.unsafe(statement);
  await sql.unsafe("ALTER TABLE requests ADD COLUMN IF NOT EXISTS hidden_at TEXT");
  await sql.unsafe("ALTER TABLE requests ADD COLUMN IF NOT EXISTS hidden_by TEXT");
  await sql.unsafe("ALTER TABLE requests ADD COLUMN IF NOT EXISTS delete_token_hmac TEXT");
  const q = async (query: string, params: unknown[] = []) =>
    (await sql.unsafe(sqlPlaceholders(query, "postgres"), params as never[])) as Record<string, unknown>[];

  return {
    kind: "postgres",
    async saveRequest(row) {
      await q(UPSERT_REQUEST, [row.id, row.need_json, row.created_at, row.delete_token_hmac]);
    },
    async getRequest(id) {
      return oneRequest(await q(SELECT_REQUEST, [id]));
    },
    async listRequests(limit) {
      return (await q(LIST_REQUESTS, [limit])).map(asRequest);
    },
    async saveBid(row) {
      await q(UPSERT_BID, [row.id, row.request_id, row.store_domain, row.key_hash, row.bid_json, row.created_at]);
    },
    async listBids() {
      return (
        await q("SELECT id, request_id, store_domain, bid_json, created_at FROM bids ORDER BY created_at ASC")
      ).map(asBid);
    },
    async saveStoreKey(row) {
      await q(UPSERT_STORE_KEY, [row.store_domain, row.key_hmac, row.created_at]);
    },
    async getStoreKey(domain) {
      const value = (await q("SELECT key_hmac FROM store_keys WHERE store_domain = ?", [domain]))[0]?.key_hmac;
      return typeof value === "string" ? value : null;
    },
    async hideRequest(id, hiddenAt, hiddenBy) {
      await q(HIDE_REQUEST, [hiddenAt, hiddenBy, id]);
    },
    async countAutoHidesSince(since) {
      return Number((await q(COUNT_AUTO_HIDES, [since]))[0]?.n ?? 0);
    },
    async countReporters(requestId) {
      return Number((await q(COUNT_REPORTERS, [requestId]))[0]?.n ?? 0);
    },
    async hasReport(requestId, ipHash) {
      return (await q(HAS_REPORT, [requestId, ipHash])).length > 0;
    },
    async bumpRate(ipHash, windowKey) {
      return Number((await q(BUMP_RATE, [ipHash, windowKey]))[0]?.count ?? 0);
    },
    async saveReport(row) {
      await q(INSERT_REPORT, [row.id, row.request_id, row.ip_hash, row.reason, row.created_at]);
    },
    async listReports() {
      return (await q("SELECT id, request_id, ip_hash, reason, created_at FROM reports ORDER BY created_at ASC")).map(
        asReport,
      );
    },
    async upsertVariants(rows) {
      if (rows.length === 0) return;
      await sql.begin(async (tx) => {
        for (const row of rows) {
          await tx.unsafe(sqlPlaceholders(UPSERT_VARIANT, "postgres"), variantParams(row) as never[]);
        }
      });
    },
    async listVariants() {
      return (await q("SELECT variant_json FROM variants")).flatMap(parseVariant);
    },
    async countVariants() {
      const rows = await q("SELECT COUNT(*) AS n FROM variants");
      return Number(rows[0]?.n ?? 0);
    },
    async latestObserved() {
      const rows = await q("SELECT MAX(observed_at) AS observed_at FROM variants");
      const value = rows[0]?.observed_at;
      return typeof value === "string" ? value : null;
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}

function sqlitePath(url: string): string {
  if (url === ":memory:" || url === "file::memory:") return ":memory:";
  if (url.startsWith("file://")) {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname);
  }
  if (url.startsWith("file:")) return url.slice("file:".length);
  return url;
}

function variantParams(row: VariantRow): unknown[] {
  return [
    row.id,
    row.store_domain,
    row.brand,
    row.model,
    row.gender,
    row.size,
    row.price_cents,
    row.currency,
    row.available,
    row.variant_json,
    row.observed_at,
  ];
}

function oneRequest(rows: Record<string, unknown>[]): RequestRow | null {
  const row = rows[0];
  return row ? asRequest(row) : null;
}

function asRequest(row: Record<string, unknown>): RequestRow {
  return {
    id: String(row.id),
    need_json: String(row.need_json),
    created_at: String(row.created_at),
    delete_token_hmac: row.delete_token_hmac == null ? null : String(row.delete_token_hmac),
  };
}

function migrateSqliteRequests(db: { prepare: (sql: string) => { all: () => { name: string }[] }; exec: (sql: string) => void }) {
  const names = new Set(db.prepare("PRAGMA table_info(requests)").all().map((column) => column.name));
  if (!names.has("hidden_at")) db.exec("ALTER TABLE requests ADD COLUMN hidden_at TEXT");
  if (!names.has("hidden_by")) db.exec("ALTER TABLE requests ADD COLUMN hidden_by TEXT");
  if (!names.has("delete_token_hmac")) db.exec("ALTER TABLE requests ADD COLUMN delete_token_hmac TEXT");
}

function asBid(row: Record<string, unknown>): BidRow {
  return {
    id: String(row.id),
    request_id: row.request_id == null ? null : String(row.request_id),
    store_domain: String(row.store_domain),
    bid_json: String(row.bid_json),
    created_at: String(row.created_at),
  };
}

function asReport(row: Record<string, unknown>): ReportRow {
  return {
    id: String(row.id),
    request_id: String(row.request_id),
    ip_hash: String(row.ip_hash),
    reason: row.reason == null ? null : String(row.reason),
    created_at: String(row.created_at),
  };
}

function parseVariant(row: Record<string, unknown>): CatalogVariant[] {
  try {
    return [JSON.parse(String(row.variant_json)) as CatalogVariant];
  } catch {
    return [];
  }
}

let singleton: Promise<Store> | null = null;

export function getStore(): Promise<Store> {
  if (!singleton) singleton = openStore();
  return singleton;
}

export function variantToRow(variant: CatalogVariant): VariantRow {
  return {
    id: variant.id,
    store_domain: variant.store_domain,
    brand: variant.brand,
    model: variant.model,
    gender: variant.gender,
    size: variant.size,
    price_cents: variant.price_cents,
    currency: variant.currency,
    available: variant.available ? 1 : 0,
    variant_json: JSON.stringify(variant),
    observed_at: variant.observed_at,
  };
}
