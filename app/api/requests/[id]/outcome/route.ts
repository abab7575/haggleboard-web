import { emptyOptions, errorResponse, json, readJson } from "../../../../../lib/http";
import { withRequestHooks } from "../../../../../lib/inline-watch";
import { assertWithinRateLimit } from "../../../../../lib/rate-limit";
import { defaultDeps, reportOutcome } from "../../../../../lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the posting agent did: { "outcome": "bought_at_winner" | "bought_elsewhere" | "did_not_buy",
 * "reason": "<optional, short, no personal data>" }. Token in X-HaggleBoard-Delete-Token or the body.
 */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const deps = await defaultDeps();
    await assertWithinRateLimit(req, deps.store);
    const { id } = await context.params;
    const body = (await readJson(req)) as Record<string, unknown> | null;
    const token = req.headers.get("x-haggleboard-delete-token")?.trim() || body?.delete_token;
    const result = await reportOutcome({ ...(body ?? {}), request_id: id, delete_token: token }, withRequestHooks(deps, req));
    return json(result, 201);
  } catch (error) {
    return errorResponse(error);
  }
}

export function OPTIONS() {
  return emptyOptions();
}
