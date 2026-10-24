import { cachePath, readCache, writeCache } from "./cache.js";
import {
  BACKOFF_MS,
  MAX_BODY_CHARS,
  MAX_CRAWL_DELAY_MS,
  MAX_LIMIT,
  MAX_PAGES,
  REQUEST_TIMEOUT_MS,
  SEVEN_DAY_BACKOFF_MS,
  USER_AGENT,
} from "./constants.js";
import { hostMatchesDomain } from "./host.js";
import { normalizeProducts, type ShopifyProduct } from "./normalize.js";
import { createPoliteScheduler } from "./politeness.js";
import { decidePath, parseRobots } from "./robots.js";
import type { StoreSeed } from "./seeds.js";
import type { CatalogVariant } from "../referee/types.js";

export type RequestLog = {
  url: string;
  status: number | null;
  waited_ms: number;
  from_cache: boolean;
  at: string;
};

export type StoreCrawlResult = {
  domain: string;
  country: string | null;
  region: string | null;
  currency: string | null;
  shop_origin: string | null;
  pages_fetched: number;
  robots_allowed: boolean;
  stopped: boolean;
  stop_reason: string | null;
  backoff_until: string | null;
  requests: RequestLog[];
  variants: CatalogVariant[];
};

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type CrawlOptions = {
  seed: StoreSeed;
  pages: number;
  limit: number;
  cacheDir: string;
  cacheTtlMs: number;
  perHostMs: number;
  globalMs: number;
  allowFast?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: FetchLike;
};

type Fetched = {
  status: number | null;
  body: string | null;
  finalUrl: string;
  stop: boolean;
  stopReason: string | null;
  backoffUntil: string | null;
};

export async function crawlStore(opts: CrawlOptions): Promise<StoreCrawlResult> {
  const now = opts.now ?? Date.now;
  const pages = clamp(opts.pages, 1, MAX_PAGES);
  const limit = clamp(opts.limit, 1, MAX_LIMIT);
  const domain = opts.seed.domain;
  const scheduler = createPoliteScheduler({
    perHostMs: opts.perHostMs,
    globalMs: opts.globalMs,
    now,
    sleep: opts.sleep,
  });
  const doFetch = opts.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const requests: RequestLog[] = [];
  const variants: CatalogVariant[] = [];
  const base: StoreCrawlResult = {
    domain,
    country: opts.seed.country,
    region: opts.seed.region,
    currency: opts.seed.currency,
    shop_origin: null,
    pages_fetched: 0,
    robots_allowed: false,
    stopped: false,
    stop_reason: null,
    backoff_until: null,
    requests,
    variants,
  };

  const robots = await fetchResource({
    url: `https://${domain}/robots.txt`,
    key: "robots",
    domain,
    cacheDir: opts.cacheDir,
    cacheTtlMs: opts.cacheTtlMs,
    scheduler,
    now,
    doFetch,
    requests,
    cacheStatuses: [200, 404],
  });
  if (robots.stop) return stopped(base, robots.stopReason, robots.backoffUntil, false);
  if (robots.status !== 200 && robots.status !== 404) {
    const status = robots.status ?? 0;
    const backoff =
      status === 401 || status === 403
        ? new Date(now() + SEVEN_DAY_BACKOFF_MS).toISOString()
        : status >= 500
          ? new Date(now() + BACKOFF_MS).toISOString()
          : null;
    const reason = status === 401 || status === 403 ? "forbidden" : `http-${status || "unknown"}`;
    return stopped(base, reason, backoff, false);
  }
  if (robots.status === 200 && robots.body != null) {
    const decision = decidePath(parseRobots(robots.body), "/products.json");
    if (!decision.allowed) return stopped(base, "robots", null, false);
    if (decision.crawlDelaySec != null) {
      const delayMs = decision.crawlDelaySec * 1000;
      if (delayMs > MAX_CRAWL_DELAY_MS) return stopped(base, "crawl-delay", null, false);
      scheduler.setHostInterval(domain, Math.max(opts.perHostMs, delayMs));
    }
  }
  base.robots_allowed = true;

  let currency = opts.seed.currency;
  if (!currency) {
    const cart = await fetchResource({
      url: `https://${domain}/cart.js`,
      key: "cart",
      domain,
      cacheDir: opts.cacheDir,
      cacheTtlMs: opts.cacheTtlMs,
      scheduler,
      now,
      doFetch,
      requests,
      cacheStatuses: [200],
    });
    if (cart.stop) return stopped(base, cart.stopReason, cart.backoffUntil, true);
    if (cart.status === 200 && cart.body) {
      try {
        const parsed = JSON.parse(cart.body) as { currency?: string };
        if (parsed.currency) currency = parsed.currency.toUpperCase();
      } catch {
        currency = null;
      }
    }
  }
  if (!currency) currency = "UNK";
  base.currency = currency;

  let origin = `https://${domain}`;
  const seen = new Set<string>();
  for (let page = 1; page <= pages; page++) {
    const url = `${origin}/products.json?limit=${limit}&page=${page}`;
    const got = await fetchResource({
      url,
      key: `products-${page}`,
      domain,
      cacheDir: opts.cacheDir,
      cacheTtlMs: opts.cacheTtlMs,
      scheduler,
      now,
      doFetch,
      requests,
      cacheStatuses: [200],
    });
    if (got.stop) return stopped(base, got.stopReason, got.backoffUntil, true);
    if (got.status !== 200 || got.body == null) {
      return stopped(base, got.status === 404 ? "not-found" : `http-${got.status ?? "unknown"}`, null, true);
    }
    let parsed: { products?: ShopifyProduct[] };
    try {
      parsed = JSON.parse(got.body) as { products?: ShopifyProduct[] };
    } catch {
      return stopped(base, "not-json", null, true);
    }
    if (!Array.isArray(parsed.products)) return stopped(base, "not-json", null, true);
    if (page === 1) {
      origin = new URL(got.finalUrl).origin;
      base.shop_origin = origin;
    }
    if (parsed.products.length === 0) break;
    let fresh = 0;
    const observedAt = new Date(now()).toISOString();
    for (const product of parsed.products) {
      const id = product.id == null ? "" : String(product.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      fresh += 1;
      variants.push(
        ...normalizeProducts([product], {
          domain,
          origin,
          currency,
          country: opts.seed.country,
          region: opts.seed.region,
          observedAt,
        }),
      );
    }
    base.pages_fetched += 1;
    if (fresh === 0 || parsed.products.length < limit) break;
  }
  return base;
}

function stopped(
  base: StoreCrawlResult,
  reason: string | null,
  backoffUntil: string | null,
  robotsAllowed: boolean,
): StoreCrawlResult {
  return {
    ...base,
    robots_allowed: robotsAllowed,
    stopped: true,
    stop_reason: reason,
    backoff_until: backoffUntil,
  };
}

async function fetchResource(opts: {
  url: string;
  key: string;
  domain: string;
  cacheDir: string;
  cacheTtlMs: number;
  scheduler: ReturnType<typeof createPoliteScheduler>;
  now: () => number;
  doFetch: FetchLike;
  requests: RequestLog[];
  cacheStatuses: number[];
}): Promise<Fetched> {
  const file = cachePath(opts.cacheDir, opts.domain, opts.key);
  const cached = await readCache(file, opts.cacheTtlMs, opts.now());
  if (cached && opts.cacheStatuses.includes(cached.status)) {
    opts.requests.push({
      url: opts.url,
      status: cached.status,
      waited_ms: 0,
      from_cache: true,
      at: new Date(opts.now()).toISOString(),
    });
    return {
      status: cached.status,
      body: cached.body,
      finalUrl: cached.final_url || opts.url,
      stop: false,
      stopReason: null,
      backoffUntil: null,
    };
  }

  const first = await request(opts, opts.url);
  if (first.stop || first.status == null) return first;
  if (![301, 302, 303, 307, 308].includes(first.status)) return first;

  const location = first.location;
  if (!location) return terminal(opts, first, "redirect");
  const next = new URL(location, opts.url);
  if (next.protocol !== "https:" || !hostMatchesDomain(next.hostname, opts.domain)) {
    return terminal(opts, first, "redirect");
  }
  const second = await request(opts, next.toString());
  if ([301, 302, 303, 307, 308].includes(second.status ?? 0)) return terminal(opts, second, "redirect");
  return second;
}

async function request(
  opts: {
    domain: string;
    cacheDir: string;
    key: string;
    scheduler: ReturnType<typeof createPoliteScheduler>;
    now: () => number;
    doFetch: FetchLike;
    requests: RequestLog[];
    cacheStatuses: number[];
    url: string;
  },
  url: string,
): Promise<Fetched & { location: string | null }> {
  const waited = await opts.scheduler.wait(opts.domain);
  const at = new Date(opts.now()).toISOString();
  try {
    const headers = new Headers();
    headers.set("User-Agent", USER_AGENT);
    headers.set("Accept", "application/json, text/plain;q=0.9, */*;q=0.8");
    const response = await opts.doFetch(url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const location = response.headers.get("location");
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      opts.requests.push({ url, status: response.status, waited_ms: waited, from_cache: false, at });
      return {
        status: response.status,
        body: null,
        finalUrl: url,
        stop: false,
        stopReason: null,
        backoffUntil: null,
        location,
      };
    }
    if (response.status === 429) {
      await response.body?.cancel().catch(() => undefined);
      const retry = retryAfterMs(response.headers.get("retry-after"), opts.now());
      const backoffUntil = new Date(opts.now() + Math.max(BACKOFF_MS, retry ?? 0)).toISOString();
      opts.requests.push({ url, status: 429, waited_ms: waited, from_cache: false, at });
      return {
        status: 429,
        body: null,
        finalUrl: url,
        stop: true,
        stopReason: "429",
        backoffUntil,
        location: null,
      };
    }
    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAX_BODY_CHARS) {
      await response.body?.cancel().catch(() => undefined);
      opts.requests.push({ url, status: response.status, waited_ms: waited, from_cache: false, at });
      return {
        status: response.status,
        body: null,
        finalUrl: url,
        stop: true,
        stopReason: "too-large",
        backoffUntil: null,
        location: null,
      };
    }
    const body = await response.text();
    if (body.length > MAX_BODY_CHARS) {
      opts.requests.push({ url, status: response.status, waited_ms: waited, from_cache: false, at });
      return {
        status: response.status,
        body: null,
        finalUrl: url,
        stop: true,
        stopReason: "too-large",
        backoffUntil: null,
        location: null,
      };
    }
    opts.requests.push({ url, status: response.status, waited_ms: waited, from_cache: false, at });
    const contentType = response.headers.get("content-type") ?? "";
    const challenge = looksLikeChallenge({
      url,
      status: response.status,
      contentType,
      body,
      mitigated: response.headers.get("cf-mitigated"),
    });
    if (challenge) {
      return {
        status: response.status,
        body: null,
        finalUrl: url,
        stop: true,
        stopReason: "challenge",
        backoffUntil: new Date(opts.now() + SEVEN_DAY_BACKOFF_MS).toISOString(),
        location: null,
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        status: response.status,
        body: null,
        finalUrl: url,
        stop: true,
        stopReason: "forbidden",
        backoffUntil: new Date(opts.now() + SEVEN_DAY_BACKOFF_MS).toISOString(),
        location: null,
      };
    }
    if (response.status >= 500) {
      return {
        status: response.status,
        body: null,
        finalUrl: url,
        stop: true,
        stopReason: `http-${response.status}`,
        backoffUntil: new Date(opts.now() + BACKOFF_MS).toISOString(),
        location: null,
      };
    }
    if (opts.cacheStatuses.includes(response.status)) {
      await writeCache(cachePath(opts.cacheDir, opts.domain, opts.key), {
        url,
        status: response.status,
        body,
        fetched_at: at,
        final_url: url,
      });
    }
    return {
      status: response.status,
      body,
      finalUrl: url,
      stop: false,
      stopReason: null,
      backoffUntil: null,
      location: null,
    };
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network";
    opts.requests.push({ url, status: null, waited_ms: waited, from_cache: false, at });
    return {
      status: null,
      body: null,
      finalUrl: url,
      stop: true,
      stopReason: reason,
      backoffUntil: null,
      location: null,
    };
  }
}

function terminal(
  opts: { requests: RequestLog[] },
  got: Fetched,
  reason: string,
): Fetched {
  return { ...got, stop: true, stopReason: reason, body: null };
}

function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(header);
  if (Number.isFinite(when)) return Math.max(0, when - now);
  return null;
}

const CHALLENGE_BODY =
  /just a moment|cf-browser-verification|challenge-platform|attention required|captcha|please verify you are a human|bot detection/i;

export function looksLikeChallenge(input: {
  url: string;
  status: number;
  contentType: string;
  body: string;
  mitigated: string | null;
}): boolean {
  const robots = input.url.includes("/robots.txt");
  const products = input.url.includes("/products.json");
  if (!robots && !products) return false;
  if (input.mitigated) return true;
  if (input.body && CHALLENGE_BODY.test(input.body.slice(0, 4000))) return true;
  if (robots && input.status === 404) return false;
  if (/text\/html/i.test(input.contentType) && (products || (robots && input.status === 200))) return true;
  return false;
}

export function stopsTheRun(reason: string | null): boolean {
  return reason === "429" || reason === "challenge";
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
