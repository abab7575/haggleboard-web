import type { AgentRoute } from "../feeds/agent-catalog.js";
import { USER_AGENT } from "../feeds/constants.js";
import {
  ARC_ASK_URL,
  ARC_CACHE_TTL_MS,
  ARC_FIND_LIMIT,
  ARC_MAX_CALLS_PER_REQUEST,
  ARC_PRECHECK_BULK_URL,
  ARC_TIMEOUT_MS,
} from "./constants.js";

/**
 * ARC (arcreport.ai) is a public, no-key record of online stores and whether an agent can reach
 * checkout there. The watcher uses two of its endpoints, read-only:
 *
 * - find_stores on the MCP server at /api/ask: stores in a category or for shopper words, each with
 *   a saved checkout link from the last 30 days. Used to pick candidate stores.
 * - POST /api/precheck/bulk: one saved record per domain (known, reachable_checkout, rails such as
 *   Shop Pay, routes with endpoints). Used to prefer stores with a known checkout route and to tell
 *   whether a store runs Shopify, which is the only public product feed the crawler knows how to read.
 *
 * ARC never fetches a store live for these calls. Answers are cached for 12 hours, and one watch run
 * makes at most ARC_MAX_CALLS_PER_REQUEST calls.
 */

export type ArcStore = { host: string; name: string | null; category: string | null; grade: string | null };

export type ArcPrecheck = {
  host: string;
  known: boolean;
  reachable_checkout: boolean | null;
  best_route: string | null;
  /** Shop Pay detected, a Shopify storefront MCP that works, or a UCP profile with dev.shopify capabilities. */
  shopify: boolean;
  /** The store's own canonical host when ARC saw one (www.example.com), else null. */
  canonical_host: string | null;
  /** Currency of the price ARC saw on its last check, if any. */
  currency: string | null;
  /**
   * The catalog search the store publishes for agents, when ARC's last check got an answer from it:
   * a UCP MCP endpoint with search_catalog (preferred), else a storefront MCP with search_shop_catalog.
   */
  agent_route: AgentRoute | null;
};

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type ArcClient = {
  findStores: (query: string) => Promise<ArcStore[]>;
  precheck: (domains: string[]) => Promise<Map<string, ArcPrecheck>>;
  /** Network calls made through this client (cache hits do not count). */
  calls: () => number;
};

type CacheEntry<T> = { at: number; value: T };
const findCache = new Map<string, CacheEntry<ArcStore[]>>();
const precheckCache = new Map<string, CacheEntry<ArcPrecheck>>();

export function clearArcCache(): void {
  findCache.clear();
  precheckCache.clear();
}

/** A client for one watch run. It refuses to make more than ARC_MAX_CALLS_PER_REQUEST network calls. */
export function createArcClient(opts: { fetch?: FetchLike; now?: () => number } = {}): ArcClient {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? Date.now;
  let calls = 0;

  async function call(url: string, body: unknown): Promise<unknown> {
    if (calls >= ARC_MAX_CALLS_PER_REQUEST) return null;
    calls += 1;
    try {
      const response = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ARC_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      return (await response.json()) as unknown;
    } catch {
      return null;
    }
  }

  return {
    calls: () => calls,
    async findStores(query) {
      const key = query.trim().toLowerCase();
      if (!key) return [];
      const hit = findCache.get(key);
      if (hit && now() - hit.at < ARC_CACHE_TTL_MS) return hit.value;
      const raw = await call(ARC_ASK_URL, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "find_stores", arguments: { q: query, limit: ARC_FIND_LIMIT } },
      });
      const stores = parseFindStores(raw);
      if (raw != null) findCache.set(key, { at: now(), value: stores });
      return stores;
    },
    async precheck(domains) {
      const out = new Map<string, ArcPrecheck>();
      const missing: string[] = [];
      for (const domain of [...new Set(domains.map((d) => d.toLowerCase()))]) {
        const hit = precheckCache.get(domain);
        if (hit && now() - hit.at < ARC_CACHE_TTL_MS) out.set(domain, hit.value);
        else missing.push(domain);
      }
      if (missing.length === 0) return out;
      const raw = await call(ARC_PRECHECK_BULK_URL, { domains: missing.slice(0, 100) });
      for (const record of parsePrecheckBulk(raw)) {
        precheckCache.set(record.host, { at: now(), value: record });
        out.set(record.host, record);
      }
      return out;
    },
  };
}

export function parseFindStores(raw: unknown): ArcStore[] {
  try {
    const text = (raw as { result?: { content?: Array<{ text?: string }> } })?.result?.content?.[0]?.text;
    if (!text) return [];
    const parsed = JSON.parse(text) as { stores?: Array<Record<string, unknown>> };
    return (parsed.stores ?? [])
      .map((store) => ({
        host: String(store.host ?? "").toLowerCase(),
        name: typeof store.name === "string" ? store.name : null,
        category: typeof store.category === "string" ? store.category : null,
        grade:
          store.grade && typeof store.grade === "object" && typeof (store.grade as { grade?: unknown }).grade === "string"
            ? ((store.grade as { grade: string }).grade)
            : null,
      }))
      .filter((store) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(store.host));
  } catch {
    return [];
  }
}

type RawPrecheck = {
  host?: string;
  input?: string;
  known?: boolean;
  reachable_checkout?: boolean | null;
  best_route?: { route?: string } | null;
  rails?: Array<{ name?: string; status?: string }> | null;
  routes?: Array<{
    route?: string;
    status?: string;
    endpoint?: string;
    catalog_tool?: string;
    product_url_tested?: string;
    profile_url?: string;
    capabilities?: string[];
  }> | null;
  price_check?: { currency?: string } | null;
};

export function parsePrecheckBulk(raw: unknown): ArcPrecheck[] {
  const results = (raw as { results?: RawPrecheck[] })?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((item) => {
    const host = String(item.host ?? item.input ?? "").toLowerCase();
    if (!host) return [];
    const rails = item.rails ?? [];
    const routes = item.routes ?? [];
    const shopPay = rails.some((rail) => /shop pay/i.test(rail.name ?? "") && rail.status === "detected");
    const storefront = routes.some((route) => route.route === "storefront_mcp" && route.status === "works");
    const shopifyUcp = routes.some((route) => (route.capabilities ?? []).some((cap) => cap.startsWith("dev.shopify")));
    let canonical: string | null = null;
    for (const route of routes) {
      for (const candidate of [route.product_url_tested, route.endpoint, route.profile_url]) {
        if (!candidate) continue;
        try {
          const url = new URL(candidate);
          if (url.protocol === "https:" && (url.hostname === host || url.hostname.endsWith(`.${host}`))) {
            canonical = url.hostname;
            break;
          }
        } catch {
          // not a URL
        }
      }
      if (canonical) break;
    }
    return [
      {
        host,
        known: item.known === true,
        reachable_checkout: typeof item.reachable_checkout === "boolean" ? item.reachable_checkout : null,
        best_route: item.best_route?.route ?? null,
        shopify: shopPay || storefront || shopifyUcp,
        canonical_host: canonical,
        currency: item.price_check?.currency ? item.price_check.currency.toUpperCase() : null,
        agent_route: agentRouteOf(host, routes),
      },
    ];
  });
}

/**
 * The agent catalog route ARC saw working, on the store's own host. UCP MCP with search_catalog
 * first. A storefront MCP is used only when its tool is search_shop_catalog (Shopify moved the
 * catalog off /api/mcp to /api/ucp/mcp; ARC's older checks can still list search_catalog there, and
 * a live tools/list on 22 Nov 2026 showed only the policies tool at /api/mcp).
 */
export function agentRouteOf(host: string, routes: NonNullable<RawPrecheck["routes"]>): AgentRoute | null {
  const onHost = (endpoint: string | undefined): string | null => {
    if (!endpoint) return null;
    try {
      const url = new URL(endpoint);
      return url.protocol === "https:" && (url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url.toString() : null;
    } catch {
      return null;
    }
  };
  const ucp = routes.find((route) => route.route === "ucp_mcp" && route.status === "works" && route.catalog_tool === "search_catalog");
  const ucpEndpoint = onHost(ucp?.endpoint);
  if (ucpEndpoint) return { route: "ucp_mcp", endpoint: ucpEndpoint, tool: "search_catalog" };
  const storefront = routes.find(
    (route) => route.route === "storefront_mcp" && route.status === "works" && route.catalog_tool === "search_shop_catalog",
  );
  const storefrontEndpoint = onHost(storefront?.endpoint);
  if (storefrontEndpoint) return { route: "storefront_mcp", endpoint: storefrontEndpoint, tool: "search_shop_catalog" };
  return null;
}
