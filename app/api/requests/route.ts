import { assertWithinRateLimit } from "../../../lib/rate-limit";
import { emptyOptions, errorResponse, json, readJson } from "../../../lib/http";
import { withRequestHooks } from "../../../lib/inline-watch";
import { defaultDeps, postRequest } from "../../../lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const deps = await defaultDeps();
    await assertWithinRateLimit(req, deps.store);
    const body = await readJson(req);
    const result = await postRequest(body, withRequestHooks(deps, req));
    return json(result, 201);
  } catch (error) {
    return errorResponse(error);
  }
}

export function OPTIONS() {
  return emptyOptions();
}
