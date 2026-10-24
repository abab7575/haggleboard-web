import { createHmac, randomBytes } from "node:crypto";
import type { Store } from "./db.js";
import { HttpError } from "./http.js";
import { assertVercelStartup } from "./startup.js";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PER_MINUTE = 10;
const PER_DAY = 100;

export type RateCounter = {
  bump(ipHash: string, windowKey: string): Promise<number>;
};

const memoryHits = new Map<string, number>();
let memorySalt: string | null = null;

const memoryCounter: RateCounter = {
  async bump(ipHash, windowKey) {
    const key = `${ipHash}\n${windowKey}`;
    const next = (memoryHits.get(key) ?? 0) + 1;
    memoryHits.set(key, next);
    return next;
  },
};

/** Vercel's forwarded header, then x-real-ip. The client-supplied X-Forwarded-For chain is ignored. */
export function clientIp(req: Request): string {
  const vercel = firstAddress(req.headers.get("x-vercel-forwarded-for"));
  if (vercel) return vercel;
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  return "unknown";
}

function firstAddress(value: string | null): string | null {
  const first = value?.split(",")[0]?.trim();
  return first || null;
}

export function rateSalt(env: NodeJS.ProcessEnv = process.env): string {
  assertVercelStartup(env);
  const configured = env.MCP_CALL_LOG_SALT?.trim();
  if (configured) return configured;
  if (!memorySalt) memorySalt = randomBytes(32).toString("hex");
  return memorySalt;
}

export function hashIp(ip: string, salt: string): string {
  return createHmac("sha256", salt).update(ip).digest("hex");
}

export function hashClient(req: Request, env: NodeJS.ProcessEnv = process.env): string {
  return hashIp(clientIp(req), rateSalt(env));
}

export type RateDecision = { ok: true } | { ok: false; retryAfter: number };

export async function takeRateLimit(ipHash: string, now: number, counter: RateCounter): Promise<RateDecision> {
  const minuteCount = await counter.bump(ipHash, `m:${Math.floor(now / MINUTE_MS)}`);
  const dayCount = await counter.bump(ipHash, `d:${Math.floor(now / DAY_MS)}`);
  if (minuteCount > PER_MINUTE) {
    const boundary = (Math.floor(now / MINUTE_MS) + 1) * MINUTE_MS;
    return { ok: false, retryAfter: Math.max(1, Math.ceil((boundary - now) / 1000)) };
  }
  if (dayCount > PER_DAY) {
    const boundary = (Math.floor(now / DAY_MS) + 1) * DAY_MS;
    return { ok: false, retryAfter: Math.max(1, Math.ceil((boundary - now) / 1000)) };
  }
  return { ok: true };
}

export async function assertWithinRateLimit(req: Request, store: Store, now = Date.now()): Promise<void> {
  const counter: RateCounter =
    store.kind === "unavailable"
      ? memoryCounter
      : { bump: (ipHash, windowKey) => store.bumpRate(ipHash, windowKey) };
  const decision = await takeRateLimit(hashClient(req), now, counter);
  if (!decision.ok) {
    throw new HttpError(429, "Too many requests", { "retry-after": String(decision.retryAfter) });
  }
}

export function resetRateLimits(): void {
  memoryHits.clear();
}
