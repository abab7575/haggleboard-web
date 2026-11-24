import type { Store } from "./db.js";
import { eventContext, writeEvents } from "./events.js";

/** Where a page view came from, coarsely. The referring URL itself is not kept. */
export function referrerClass(referer: string | null, ownHost: string | null): string {
  if (!referer) return "none";
  let host: string;
  try {
    host = new URL(referer).hostname.toLowerCase();
  } catch {
    return "other";
  }
  if (ownHost && host === ownHost.toLowerCase()) return "haggleboard";
  if (/(^|\.)(google|bing|duckduckgo|yahoo|yandex|baidu|ecosia|brave)\.[a-z.]+$/.test(host)) return "search";
  if (/(^|\.)(chatgpt\.com|openai\.com|claude\.ai|perplexity\.ai|gemini\.google\.com|copilot\.microsoft\.com|you\.com|phind\.com)$/.test(host)) {
    return "assistant";
  }
  return "other";
}

/**
 * page.read for a request or store page. Best effort: a failed write never breaks the page.
 * Called from server components with next/headers; outside a request (tests) it does nothing.
 */
export async function logPageRead(
  store: Store,
  page: { kind: "request" | "store"; path: string; request_id?: string | null; store_domain?: string | null },
): Promise<void> {
  if (store.kind === "unavailable") return;
  try {
    const { headers } = await import("next/headers");
    const h = await headers();
    const host = h.get("host") ?? "haggleboard.com";
    const proto = /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https";
    const req = new Request(`${proto}://${host}${page.path}`, { headers: h });
    const ctx = eventContext(req, "web");
    await writeEvents(
      store,
      [
        {
          type: "page.read",
          request_id: page.request_id ?? null,
          store_domain: page.store_domain ?? null,
          public: { page: page.kind, agent_kind: ctx.agent.kind, referrer_class: referrerClass(h.get("referer"), host.split(":")[0] ?? null) },
        },
      ],
      ctx,
    );
  } catch {
    // No request scope (tests, static render) or the write failed: skip.
  }
}
