import { createdHtml, existingHtml, explainHtml, FIND_HEADERS, handleFind, readFindInput } from "./find.js";
import { DISCLAIMER } from "./copy.js";
import { HttpError } from "./http.js";
import { withRequestHooks } from "./inline-watch.js";
import { defaultDeps } from "./service.js";

function wantsJson(req: Request, forced: boolean): boolean {
  if (forced) return true;
  const accept = (req.headers.get("accept") ?? "").toLowerCase();
  if (!accept.includes("application/json")) return false;
  const html = accept.indexOf("text/html");
  return html < 0 || accept.indexOf("application/json") < html;
}

function site(req: Request): string {
  const configured = process.env.SITE_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  return new URL(req.url).origin;
}

/** Shared by /find (HTML or JSON by Accept) and /find.json (always JSON). */
export async function findResponse(req: Request, forceJson: boolean): Promise<Response> {
  const asJson = wantsJson(req, forceJson);
  const headers = { ...FIND_HEADERS, "content-type": asJson ? "application/json; charset=utf-8" : "text/html; charset=utf-8" };
  try {
    const deps = await defaultDeps();
    const input = readFindInput(new URL(req.url));
    const outcome = await handleFind(req, input, withRequestHooks(deps, req, "find"));
    if (outcome.kind === "explain") {
      const body = asJson
        ? JSON.stringify({
            created: false,
            reason: outcome.reason,
            how: `Open ${site(req)}/find?q=what+you+want (optional &size=, &brand=, &country=). Ask your agent to haggle for it on HaggleBoard.`,
            disclaimer: DISCLAIMER,
          })
        : explainHtml(outcome.reason, site(req));
      return new Response(req.method === "HEAD" ? null : body, { status: 200, headers });
    }
    if (outcome.kind === "existing") {
      const body = asJson
        ? JSON.stringify({
            created: false,
            duplicate: true,
            request_id: outcome.request_id,
            board_url: `/r/${outcome.request_id}`,
            note: "Same request from you a moment ago. The delete token was shown the first time.",
            disclaimer: DISCLAIMER,
          })
        : existingHtml(outcome.request_id);
      return new Response(body, { status: 200, headers });
    }
    const body = asJson ? JSON.stringify({ created: true, ...outcome.result }) : createdHtml(outcome.result);
    return new Response(body, { status: outcome.result.persisted ? 201 : 200, headers });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.message : "Something went wrong";
    const extra = error instanceof HttpError ? error.headers : {};
    const body = asJson ? JSON.stringify({ error: message }) : `<!doctype html><title>HaggleBoard</title><p>${message.replace(/</g, "&lt;")}</p>`;
    if (status === 500) console.error("find failed");
    return new Response(body, { status, headers: { ...headers, ...extra } });
  }
}
