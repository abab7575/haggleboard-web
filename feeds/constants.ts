import { USER_AGENT } from "../lib/copy.js";

export { USER_AGENT };

/** About one request every few seconds, per store. */
export const DEFAULT_HOST_INTERVAL_MS = 5_000;
export const DEFAULT_GLOBAL_INTERVAL_MS = 5_000;

/** Hard floor so a worker cannot tighten the crawl by passing a smaller flag. */
export const HOST_INTERVAL_FLOOR_MS = 3_000;
export const GLOBAL_INTERVAL_FLOOR_MS = 2_000;

export const BACKOFF_MS = 24 * 60 * 60 * 1000;
export const SEVEN_DAY_BACKOFF_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_CRAWL_DELAY_MS = 120_000;
export const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
export const MAX_PAGES = 20;
export const MAX_LIMIT = 250;
export const REQUEST_TIMEOUT_MS = 20_000;
export const MAX_BODY_CHARS = 5_000_000;

export function resolveHostInterval(requested: number | undefined, allowFast = false): number {
  const value = requested ?? DEFAULT_HOST_INTERVAL_MS;
  if (!Number.isFinite(value) || value < 0) {
    return allowFast ? 0 : HOST_INTERVAL_FLOOR_MS;
  }
  if (allowFast) return value;
  return Math.max(HOST_INTERVAL_FLOOR_MS, value);
}

export function resolveGlobalInterval(requested: number | undefined, allowFast = false): number {
  const value = requested ?? DEFAULT_GLOBAL_INTERVAL_MS;
  if (!Number.isFinite(value) || value < 0) {
    return allowFast ? 0 : GLOBAL_INTERVAL_FLOOR_MS;
  }
  if (allowFast) return value;
  return Math.max(GLOBAL_INTERVAL_FLOOR_MS, value);
}
