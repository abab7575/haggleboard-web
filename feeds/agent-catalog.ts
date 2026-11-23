import { hostMatchesDomain } from "./host.js";
import { normalizeProduct, type ShopifyProduct } from "./normalize.js";
import { phraseMatch } from "../referee/attributes.js";
import type { CatalogVariant } from "../referee/types.js";

/**
 * A STORE'S OWN AGENT ROUTE. Many Shopify stores publish a catalog search for agents: a UCP MCP
 * endpoint (`/api/ucp/mcp`, tool `search_catalog`) or the older storefront MCP (`/api/mcp`, tool
 * `search_shop_catalog`). ARC's precheck lists, per store, which of these answered on its last
 * saved check. When one is listed, the watcher spends its one product request for that store on a
 * product-specific search there instead of reading the first page of the store's whole feed.
 *
 * What a store really accepted (checked 22 Nov 2026 against three stores, three requests or fewer each):
 *   tools/call search_catalog {
 *     meta: { "ucp-agent": { profile } },
 *     catalog: { query, pagination: { limit }, context: { address_country, language, currency, intent } }
 *   }
 * The answer is JSON-RPC with result.content[0].text (and structuredContent) holding
 * { products: [{ id, title, url, handle, price_range, variants: [{ id, title, price: { amount, currency },
 *   availability: { available }, options: [{ name, label }] }] }] }. Amounts are minor units. A store
 * may answer in its own currency whatever the context asks for, so the currency is read per variant.
 * At most 10 variants come back per product, so a requested size can be missing from the answer.
 */

export type AgentRoute = {
  /** ARC's route name: ucp_mcp or storefront_mcp. */
  route: "ucp_mcp" | "storefront_mcp";
  endpoint: string;
  tool: "search_catalog" | "search_shop_catalog";
};

/**
 * The agent profile sent as meta.ucp-agent.profile. HaggleBoard does not publish its own UCP agent
 * profile yet (nothing is deployed), so this is Shopify's public example profile, the one stores
 * accept for catalog search. Once haggleboard.com serves its own, set UCP_AGENT_PROFILE_URL.
 * The caller is still identified by the HaggleBoard-bot user agent on every request.
 */
export const DEFAULT_UCP_AGENT_PROFILE_URL =
  "https://shopify.dev/ucp/agent-profiles/examples/2026-08-25/valid-with-capabilities.json";

export function ucpAgentProfileUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.UCP_AGENT_PROFILE_URL?.trim();
  return value && /^https:\/\//.test(value) ? value : DEFAULT_UCP_AGENT_PROFILE_URL;
}

export const AGENT_SEARCH_LIMIT = 5;

/** The JSON-RPC body for one catalog search. Product words only, never the poster's own text. */
export function searchBody(route: AgentRoute, query: string, profile: string, currency: string | null): string {
  const args =
    route.tool === "search_catalog"
      ? {
          meta: { "ucp-agent": { profile } },
          catalog: {
            query,
            pagination: { limit: AGENT_SEARCH_LIMIT },
            context: {
              address_country: currency === "GBP" ? "GB" : currency === "EUR" ? "IE" : "US",
              language: "en",
              currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : "USD",
              intent: "HaggleBoard price check for one product a shopper asked for",
            },
          },
        }
      : { query, context: "HaggleBoard price check for one product a shopper asked for" };
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: route.tool, arguments: args } });
}

type Money = { amount?: unknown; currency?: unknown };
type RawVariant = {
  id?: unknown;
  title?: unknown;
  price?: Money | string | number | null;
  availability?: { available?: unknown } | null;
  available?: unknown;
  options?: Array<{ name?: unknown; label?: unknown; value?: unknown }> | null;
};
type RawProduct = {
  id?: unknown;
  title?: unknown;
  url?: unknown;
  handle?: unknown;
  vendor?: unknown;
  description?: { html?: unknown; plain?: unknown } | string | null;
  variants?: RawVariant[] | null;
};

function productsOf(payload: unknown): RawProduct[] {
  const record = payload as { result?: { structuredContent?: { products?: unknown }; content?: Array<{ text?: unknown }> } } | null;
  const structured = record?.result?.structuredContent?.products;
  if (Array.isArray(structured)) return structured as RawProduct[];
  for (const part of record?.result?.content ?? []) {
    if (typeof part?.text !== "string") continue;
    try {
      const parsed = JSON.parse(part.text) as { products?: unknown };
      if (Array.isArray(parsed.products)) return parsed.products as RawProduct[];
    } catch {
      // not catalog JSON
    }
  }
  return [];
}

function lastId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  const tail = text.split("/").pop() ?? text;
  return /^[A-Za-z0-9_-]{1,64}$/.test(tail) ? tail : null;
}

function moneyOf(price: RawVariant["price"]): { cents: number; currency: string | null } | null {
  if (price && typeof price === "object") {
    const amount = Number(price.amount);
    if (!Number.isFinite(amount) || amount < 0) return null;
    const currency = typeof price.currency === "string" && /^[A-Za-z]{3}$/.test(price.currency) ? price.currency.toUpperCase() : null;
    // UCP amounts are minor units (10000 = 100.00).
    return { cents: Math.round(amount), currency };
  }
  return null;
}

/**
 * Parse a catalog search answer into catalog variants. `brandHint` names the brand when the store is
 * that brand's own site (its titles often leave the brand out) or when the product's own text names it.
 */
export function parseAgentCatalog(
  payload: unknown,
  ctx: { domain: string; fallbackCurrency: string | null; observedAt: string; brandHint: string | null; official: boolean },
): CatalogVariant[] {
  const out: CatalogVariant[] = [];
  for (const product of productsOf(payload).slice(0, 20)) {
    const title = typeof product.title === "string" ? product.title.trim() : "";
    const productId = lastId(product.id);
    if (!title || !productId || !Array.isArray(product.variants)) continue;
    let url: URL | null = null;
    try {
      url = typeof product.url === "string" ? new URL(product.url) : null;
    } catch {
      url = null;
    }
    if (!url || url.protocol !== "https:" || !hostMatchesDomain(url.hostname, ctx.domain)) continue;
    const handle = typeof product.handle === "string" && product.handle ? product.handle : (url.pathname.split("/").pop() ?? productId);
    const description =
      typeof product.description === "string"
        ? product.description
        : String(product.description?.plain ?? product.description?.html ?? "");
    const vendor =
      typeof product.vendor === "string" && product.vendor.trim()
        ? product.vendor.trim()
        : ctx.brandHint && (ctx.official || phraseMatch(ctx.brandHint, `${title} ${description.slice(0, 2000)}`))
          ? ctx.brandHint
          : "";
    const optionNames: string[] = [];
    const variants = product.variants.slice(0, 50).flatMap((variant) => {
      const id = lastId(variant.id);
      const money = moneyOf(variant.price);
      if (!id || !money) return [];
      const options = (variant.options ?? []).map((option) => ({
        name: typeof option.name === "string" ? option.name : "",
        value: typeof option.label === "string" ? option.label : typeof option.value === "string" ? option.value : "",
      }));
      for (const option of options) if (option.name && !optionNames.includes(option.name) && optionNames.length < 3) optionNames.push(option.name);
      const slot = (n: number) => options.find((option) => option.name === optionNames[n])?.value ?? null;
      const available =
        typeof variant.availability?.available === "boolean" ? variant.availability.available : variant.available === true;
      return [
        {
          shopify: {
            id,
            title: typeof variant.title === "string" ? variant.title : null,
            option1: slot(0),
            option2: slot(1),
            option3: slot(2),
            price: (money.cents / 100).toFixed(2),
            available,
          },
          currency: money.currency,
        },
      ];
    });
    if (variants.length === 0) continue;
    const shaped: ShopifyProduct = {
      id: productId,
      title,
      handle,
      vendor,
      options: optionNames.map((name, index) => ({ name, position: index + 1 })),
      variants: variants.map((item) => item.shopify),
    };
    const currency = variants.find((item) => item.currency)?.currency ?? ctx.fallbackCurrency ?? "UNK";
    const base = `${url.origin}${url.pathname}`;
    for (const variant of normalizeProduct(shaped, {
      domain: ctx.domain,
      origin: url.origin,
      currency,
      country: null,
      region: null,
      observedAt: ctx.observedAt,
    })) {
      out.push({ ...variant, product_url: `${base}?variant=${encodeURIComponent(variant.external_variant_id)}` });
    }
  }
  return out;
}

/** The product words for a catalog search: brand, model, and gender. Never the poster's text. */
export function agentQuery(need: { brand: string | null; model: string | null; gender: string | null }): string | null {
  const gender = need.gender === "men" ? "mens" : need.gender === "women" ? "womens" : null;
  const words = [gender, need.brand, need.model].filter(Boolean).join(" ").trim();
  return words ? words.slice(0, 120) : null;
}
