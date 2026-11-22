import { tmpdir } from "node:os";
import path from "node:path";
import { crawlStore, stopsTheRun } from "../feeds/crawl.js";
import { CACHE_TTL_MS, resolveGlobalInterval, resolveHostInterval } from "../feeds/constants.js";
import { createPoliteScheduler, type PoliteScheduler } from "../feeds/politeness.js";
import { domainBlocked, readQueue } from "../feeds/queue.js";
import { loadRemoved, type StoreSeed } from "../feeds/seeds.js";
import type { RequestOrigin, Store } from "../lib/db.js";
import type { Statement } from "../lib/db.js";
import { eventStatement, requestIsInternal, type NewEvent } from "../lib/events.js";
import { recordOffers, variantOffer } from "../lib/service.js";
import {
  claimWatchRun,
  finishWatchRun,
  getFetchState,
  recordFetchStatement,
  watchOfferStatements,
  type WatchStoreResult,
  type WatchSummary,
} from "../lib/watch-store.js";
import { productMatches } from "../referee/match.js";
import { normalizeStoredNeed } from "../referee/parse.js";
import type { CatalogVariant, ResolvedNeed } from "../referee/types.js";
import { createArcClient, type ArcClient } from "./arc.js";
import { chooseCandidates, type Candidate } from "./candidates.js";
import {
  arcEnabled,
  storeRulesEnabled,
  WATCH_FEED_LIMIT,
  WATCH_FEED_REQUESTS_PER_STORE,
  WATCH_MAX_STORE_FETCHES,
  WATCH_ROBOTS_REQUESTS_PER_STORE,
} from "./constants.js";
import { queueStoreNotifications, type NotificationDecision } from "./notify.js";
import { applyStoreRule, getStoreRule, privateOfferStatement, storeHasClaimed } from "./store-rules.js";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type WatchOptions = {
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Reuse one scheduler across runs in the same process (the CLI worker does). */
  scheduler?: PoliteScheduler;
  arc?: ArcClient | null;
  cacheDir?: string;
  env?: NodeJS.ProcessEnv;
  removed?: Set<string>;
  seeds?: StoreSeed[];
  queuePath?: string;
};

export type WatchResult = {
  request_id: string;
  ran: boolean;
  summary: WatchSummary | null;
  offers: CatalogVariant[];
  private_offers: number;
  notifications: NotificationDecision[];
};

class FetchCapError extends Error {
  constructor() {
    super("fetch cap");
    this.name = "FetchCapError";
  }
}

export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WATCH_CACHE_DIR?.trim()) return env.WATCH_CACHE_DIR.trim();
  // Serverless file systems are read-only outside the temp directory.
  if (env.VERCEL) return path.join(tmpdir(), "haggleboard-feed-cache");
  return path.join(process.cwd(), "feeds", "cache");
}

/** One scheduler with the crawler's own resolved intervals. They cannot go below the built-in floor. */
export function watcherScheduler(opts: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): PoliteScheduler {
  return createPoliteScheduler({
    perHostMs: resolveHostInterval(undefined, false),
    globalMs: resolveGlobalInterval(undefined, false),
    now: opts.now,
    sleep: opts.sleep,
  });
}

/**
 * Watch one stored request: find stores that may carry the product, read each one's public price
 * politely, store what matched, and (only when the flags are on) apply claimed stores' rules and
 * queue store notifications. A request is watched at most once.
 */
export async function runWatch(
  store: Store,
  request: { id: string; need: ResolvedNeed | Partial<ResolvedNeed>; origin: RequestOrigin },
  loadVariants: () => Promise<CatalogVariant[]>,
  opts: WatchOptions = {},
): Promise<WatchResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const need = normalizeStoredNeed(request.need as Partial<ResolvedNeed>);
  const empty: WatchResult = { request_id: request.id, ran: false, summary: null, offers: [], private_offers: 0, notifications: [] };
  if (store.kind === "unavailable") return empty;
  if (!(await claimWatchRun(store, request.id, new Date(now()).toISOString()))) return empty;

  const arc = opts.arc !== undefined ? opts.arc : arcEnabled(env) ? createArcClient({ fetch: opts.fetch, now }) : null;
  const removed = opts.removed ?? loadRemoved();
  const queuePath = opts.queuePath ?? path.join(process.cwd(), "feeds", "jobs", "queue.json");
  const queue = await readQueue(queuePath);
  const blocked = async (domain: string): Promise<string | null> => {
    const nowIso = new Date(now()).toISOString();
    if (domainBlocked(queue, domain, nowIso)) return "the store is in a back-off";
    const state = await getFetchState(store, domain);
    if (state.backoff_until && state.backoff_until > nowIso) return "the store is in a back-off";
    return null;
  };

  const summary: WatchSummary = { stores: [], store_fetches: 0, arc_calls: 0, stopped: null };
  const found: CatalogVariant[] = [];
  let privateOffers = 0;

  if (!need.brand && !need.model) {
    summary.stopped = "no product name to look up";
    await finishWatchRun(store, request.id, summary, new Date(now()).toISOString());
    return { ...empty, ran: true, summary };
  }

  const candidates = await chooseCandidates(need, {
    arc,
    removed,
    blocked,
    variants: await loadVariants(),
    seeds: opts.seeds,
  });
  summary.arc_calls = arc?.calls() ?? 0;
  const internal = await requestIsInternal(store, request.id, request.origin !== "outside");
  const watcherEvent = (event: NewEvent): Statement =>
    eventStatement({ ...event, request_id: request.id, internal, agent_class: "haggleboard" }, null);
  await store.batch(
    candidates.map((candidate) =>
      watcherEvent({
        type: "store.matched",
        store_domain: candidate.domain,
        at: new Date(now()).toISOString(),
        public: {
          found_via: candidate.source === "brand" ? "brand_site" : candidate.source === "arc" ? "arc" : "seed_list",
          checkout_route_known: candidate.checkout_route_known,
          readable: candidate.fetchable,
          skip_reason: candidate.skip_reason,
        },
      }),
    ),
  );

  const scheduler = opts.scheduler ?? watcherScheduler({ now, sleep: opts.sleep });
  const baseFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const cacheDir = opts.cacheDir ?? defaultCacheDir(env);
  const rulesOn = storeRulesEnabled(env);
  let hardStops = 0;

  for (const candidate of candidates) {
    const result: WatchStoreResult = {
      store_domain: candidate.domain,
      source: candidate.source,
      status: "skipped",
      reason: candidate.skip_reason,
      checkout_route_known: candidate.checkout_route_known,
      matched: 0,
      fetches: 0,
    };
    summary.stores.push(result);
    if (!candidate.fetchable) continue;
    if (hardStops >= 2) {
      result.reason = "the run stopped after a second rate limit or bot challenge";
      continue;
    }
    if (summary.store_fetches >= WATCH_MAX_STORE_FETCHES) {
      result.reason = "the per-request fetch limit was reached";
      continue;
    }

    // Keep the per-store gap across runs and processes that share this database.
    const state = await getFetchState(store, candidate.domain);
    const since = state.last_fetch_at ? now() - Date.parse(state.last_fetch_at) : Number.POSITIVE_INFINITY;
    const gap = resolveHostInterval(undefined, false);
    if (since < gap) await (opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(gap - since);

    let storeFetches = 0;
    let capped = false;
    const perStoreCap = WATCH_FEED_REQUESTS_PER_STORE + WATCH_ROBOTS_REQUESTS_PER_STORE;
    const budgeted: FetchLike = async (url, init) => {
      if (storeFetches >= perStoreCap || summary.store_fetches >= WATCH_MAX_STORE_FETCHES) {
        capped = true;
        throw new FetchCapError();
      }
      storeFetches += 1;
      summary.store_fetches += 1;
      return baseFetch(url, init);
    };

    const readStarted = now();
    const crawl = await crawlStore({
      seed: { domain: candidate.fetch_host, region: "other", country: null, currency: candidate.currency },
      pages: 1,
      limit: WATCH_FEED_LIMIT,
      cacheDir,
      cacheTtlMs: CACHE_TTL_MS,
      perHostMs: resolveHostInterval(undefined, false),
      globalMs: resolveGlobalInterval(undefined, false),
      now,
      sleep: opts.sleep,
      fetch: budgeted,
      scheduler,
      skipCurrencyLookup: true,
    });
    result.fetches = storeFetches;
    if (stopsTheRun(crawl.stop_reason)) hardStops += 1;

    const variants = crawl.variants.map((variant) => ({ ...variant, store_domain: candidate.domain }));
    const matches =
      crawl.stopped && crawl.variants.length === 0
        ? []
        : variants.filter((variant) => productMatches(variant, { ...need, max_price_cents: null, currency: null }, true));
    const cheapest = [...matches].sort((a, b) => a.price_cents - b.price_cents)[0] ?? null;
    // The fetch state and store.read in one transaction.
    if (storeFetches > 0) {
      const backoff = crawl.backoff_until ? { until: crawl.backoff_until, reason: crawl.stop_reason ?? "backoff" } : null;
      const at = new Date(now()).toISOString();
      await store.batch([
        recordFetchStatement(candidate.domain, at, backoff),
        watcherEvent({
          type: "store.read",
          store_domain: candidate.domain,
          at,
          public: {
            outcome: readOutcome(crawl.stopped && crawl.variants.length === 0 ? crawl.stop_reason : null, matches.length > 0),
            ms: Math.max(0, now() - readStarted),
            fetches: storeFetches,
            public_price: cheapest ? cheapest.price : null,
            currency: cheapest ? cheapest.currency : null,
            in_stock: cheapest ? cheapest.available : null,
          },
        }),
      ]);
    }

    if (crawl.stopped && crawl.variants.length === 0) {
      result.reason = capped ? "would need more than one request (redirect)" : skipReason(crawl.stop_reason);
      continue;
    }
    if (!cheapest) {
      result.status = "no_match";
      result.reason = "the store's first feed page did not list this product";
      continue;
    }
    result.status = "answered";
    result.reason = candidate.currency ? null : "currency not known; check the store's page";
    result.matched = matches.length;
    found.push(...matches);
    // The store's price rows and its offer.made (plus any lead.changed) in one transaction.
    await recordOffers(store, request.id, [variantOffer(cheapest, "watcher")], {
      now: now(),
      also: watchOfferStatements(request.id, matches),
    });

    if (rulesOn && need.holding && (await storeHasClaimed(store, candidate.domain))) {
      const rule = await getStoreRule(store, candidate.domain);
      if (rule) {
        const decision = applyStoreRule(rule, cheapest, need, request.id, now());
        if (decision.offer) {
          const offer = decision.offer;
          await recordOffers(
            store,
            request.id,
            [
              {
                store_domain: offer.store_domain,
                source: "private_offer",
                via: "store_rule",
                price_cents: offer.price_cents,
                currency: offer.currency,
                available: true,
                product_url: offer.product_url,
                title: offer.title,
                expires_at: offer.expires_at,
              },
            ],
            { now: now(), also: [privateOfferStatement(offer)] },
          );
          privateOffers += 1;
        }
      }
    }
  }
  if (hardStops >= 2) summary.stopped = "a second rate limit or bot challenge";

  const carrying = [...new Set(found.map((variant) => variant.store_domain))];
  const notifications = await queueStoreNotifications(
    store,
    { requestId: request.id, origin: request.origin, storesCarrying: carrying },
    env,
    removed,
  );
  await finishWatchRun(store, request.id, summary, new Date(now()).toISOString());
  return { request_id: request.id, ran: true, summary, offers: found, private_offers: privateOffers, notifications };
}

/** DATA.md outcomes: found, not found, blocked, robots disallowed, timeout (plus unreadable). */
function readOutcome(stop: string | null, matched: boolean): string {
  if (!stop) return matched ? "found" : "not_found";
  switch (stop) {
    case "robots":
    case "crawl-delay":
      return "robots_disallowed";
    case "429":
    case "challenge":
    case "forbidden":
      return "blocked";
    case "timeout":
    case "network":
      return "timeout";
    case "not-found":
      return "not_found";
    default:
      return "unreadable";
  }
}

function skipReason(stop: string | null): string {
  switch (stop) {
    case "robots":
      return "robots.txt does not allow the product feed";
    case "crawl-delay":
      return "robots.txt asks for a longer delay than we wait";
    case "429":
      return "the store rate-limited us; backed off for at least a day";
    case "challenge":
    case "forbidden":
      return "the store turned the bot away; backed off for a week";
    case "not-found":
      return "no public product feed at this store";
    case "not-json":
      return "the store's feed was not readable";
    case "redirect":
      return "the feed redirected off the store's own site";
    case "too-large":
      return "the feed was too large";
    case "timeout":
    case "network":
      return "the store did not answer";
    default:
      return stop ? `could not read the store (${stop})` : "could not read the store";
  }
}

export type { Candidate };
