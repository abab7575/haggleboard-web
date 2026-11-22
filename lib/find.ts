import { createHash } from "node:crypto";
import { agentFromRequest } from "./agents.js";
import { DISCLAIMER, PRICE_NOTE } from "./copy.js";
import { asEvent } from "./events.js";
import { assertWithinRateLimit } from "./rate-limit.js";
import { postRequest, type Deps } from "./service.js";

/**
 * ONE-ADDRESS POSTING. GET /find?q=<what they want>[&size=&brand=&country=] creates a request
 * exactly as POST /api/requests does, for agents that can only open a web page.
 *
 * Never created for: link prefetchers and prerenders (Sec-Purpose, Purpose, X-Moz, Next-Router-Prefetch
 * headers, HEAD), search and training crawlers, or chat link previews (lib/agents.ts kinds
 * "search", "training", "preview"). Those get a page explaining how to post.
 *
 * The same q (with the same size, brand and country) from the same caller within DEDUPE_MS returns
 * the existing request instead of a second one. The delete token is shown only the first time.
 */
export const DEDUPE_MS = 10 * 60 * 1000;

export const FIND_HEADERS: Record<string, string> = {
  "cache-control": "private, no-store, max-age=0",
  "cdn-cache-control": "no-store",
  "vercel-cdn-cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
  vary: "accept, user-agent",
};

export type FindInput = { q: string; size?: string; brand?: string; country?: string };

export function readFindInput(url: URL): FindInput | null {
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (!q) return null;
  const pick = (name: string) => {
    const value = url.searchParams.get(name)?.trim();
    return value ? value : undefined;
  };
  return { q: q.slice(0, 500), size: pick("size"), brand: pick("brand"), country: pick("country") };
}

/** Why a request must not create a need, or null when it may. */
export function nonCreatingReason(req: Request): string | null {
  if (req.method === "HEAD") return "a HEAD request";
  const h = req.headers;
  const purpose = `${h.get("sec-purpose") ?? ""} ${h.get("purpose") ?? ""} ${h.get("x-purpose") ?? ""} ${h.get("x-moz") ?? ""}`.toLowerCase();
  if (/prefetch|prerender|preview/.test(purpose)) return "a link prefetch";
  if (h.get("next-router-prefetch") || h.get("rsc")) return "a link prefetch";
  const agent = agentFromRequest(req);
  if (agent.kind === "search" || agent.kind === "training") return `a crawler (${agent.agent_class})`;
  if (agent.kind === "preview") return `a link preview (${agent.agent_class})`;
  return null;
}

export function findKey(input: FindInput): string {
  const norm = (value: string | undefined) => (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256")
    .update([norm(input.q), norm(input.size), norm(input.brand), norm(input.country)].join("\n"))
    .digest("hex");
}

async function recentDuplicate(deps: Deps, key: string, callerHash: string | null, now: number): Promise<string | null> {
  if (!callerHash || deps.store.kind === "unavailable") return null;
  const rows = await deps.store.select(
    `SELECT id, at, type, request_id, store_domain, agent_class, internal, public, private FROM events
     WHERE type = 'request.posted' AND caller_hash = ? AND at >= ? ORDER BY at DESC LIMIT 50`,
    [callerHash, new Date(now - DEDUPE_MS).toISOString()],
  );
  for (const row of rows) {
    const event = asEvent(row);
    if (event.private.find_key === key && event.request_id && (await deps.store.getRequest(event.request_id))) return event.request_id;
  }
  return null;
}

export type FindResult =
  | { kind: "explain"; reason: string }
  | { kind: "created"; result: Awaited<ReturnType<typeof postRequest>> }
  | { kind: "existing"; request_id: string };

/** deps must carry the request's context (withRequestHooks(..., "find")). */
export async function handleFind(req: Request, input: FindInput | null, deps: Deps, now = Date.now()): Promise<FindResult> {
  const reason = nonCreatingReason(req);
  if (reason) return { kind: "explain", reason };
  if (!input) return { kind: "explain", reason: "no q" };
  await assertWithinRateLimit(req, deps.store, now);
  const key = findKey(input);
  const existing = await recentDuplicate(deps, key, deps.context?.caller_hash ?? null, now);
  if (existing) return { kind: "existing", request_id: existing };
  const result = await postRequest(
    { text: input.q, size: input.size, brand: input.brand, country: input.country },
    { ...deps, findKey: key },
  );
  return { kind: "created", result };
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STYLE = "body{font-family:system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;line-height:1.5}code{background:#f3f3f3;padding:0 .2rem}li{margin:.4rem 0}";

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)} · HaggleBoard</title><style>${STYLE}</style></head><body>${body}<hr><p><small>${esc(DISCLAIMER)}</small></p></body></html>`;
}

export function explainHtml(reason: string, site: string): string {
  return page(
    "Post a request",
    `<h1>Post what you want to buy</h1>
<p>Nothing was posted: this looked like ${esc(reason)}. Requests are created only when an agent or a person opens the address on purpose.</p>
<p>Open <code>${esc(site)}/find?q=what+you+want</code>, for example <code>${esc(site)}/find?q=hoka+clifton+9+mens+size+10</code>. Optional: <code>&amp;size=</code>, <code>&amp;brand=</code>, <code>&amp;country=</code>. Add <code>Accept: application/json</code> or use <code>/find.json</code> for JSON.</p>
<p>Ask your agent to haggle for it on HaggleBoard. Agents with tools can use the MCP server at <code>${esc(site)}/api/mcp</code> or <code>POST ${esc(site)}/api/requests</code>. More: <a href="/llms.txt">llms.txt</a>, <a href="/skill.md">the skill</a>.</p>
<p>Do not put names, emails, addresses or phone numbers in a request.</p>`,
  );
}

export function existingHtml(id: string): string {
  return page(
    "Already posted",
    `<h1>Already posted</h1>
<p>You asked for the same thing a moment ago, so no second request was made. Its page: <a href="/r/${esc(id)}">/r/${esc(id)}</a>. The delete token was shown once, the first time.</p>`,
  );
}

export function createdHtml(result: Awaited<ReturnType<typeof postRequest>>): string {
  const offers = result.offers
    .slice(0, 10)
    .map(
      (offer) =>
        `<li><strong>${esc(offer.price)} ${esc(offer.currency)}</strong> at ${esc(offer.store_domain)}${offer.available ? "" : " (sold out)"}: <a href="${esc(offer.product_url)}" rel="nofollow">${esc(offer.title || `${offer.brand} ${offer.model}`)}</a></li>`,
    )
    .join("");
  const stored = result.persisted && result.board_url;
  return page(
    "Posted",
    `<h1>Posted: ${esc((result.need as { brand?: string | null }).brand ?? "")} ${esc(result.need.model ?? result.need.text ?? "")}</h1>
${stored ? `<p>Request page: <a href="${esc(result.board_url)}">${esc(result.board_url)}</a>. Stores have until ${esc(result.auction?.deadline ?? "")} UTC to answer; open the request page after that to see who won.</p>` : "<p>Nothing was stored: this server has no database. The offers below are from the public snapshot.</p>"}
${stored && result.delete_token ? `<p><a href="${esc(result.board_url)}#t=${esc(encodeURIComponent(result.delete_token))}">Watch your auction live, with your amounts</a>. That link holds your token after the #, which never leaves your browser; do not share it. The public page is <a href="${esc(result.board_url)}">${esc(result.board_url)}</a>.</p>` : ""}
${result.delete_token ? `<p>Delete token (shown once, keep it private): <code>${esc(result.delete_token)}</code>. It removes the request and unlocks the private view through the API.</p>` : ""}
<h2>Offers so far</h2>
${offers ? `<ol>${offers}</ol>` : "<p>No public listing matched yet.</p>"}
<p>${esc(PRICE_NOTE)} Checkout is on the store's own site.</p>`,
  );
}
