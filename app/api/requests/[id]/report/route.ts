import { emptyOptions, errorResponse, json, readJson } from "../../../../../lib/http";
import { assertWithinRateLimit, hashClient } from "../../../../../lib/rate-limit";
import { defaultDeps, reportNeed } from "../../../../../lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const deps = await defaultDeps();
    await assertWithinRateLimit(req, deps.store);
    const { id } = await context.params;
    const type = req.headers.get("content-type") ?? "";
    let reason = "";
    let deleteToken: string | null = null;
    if (type.includes("application/json")) {
      const body = await readJson(req);
      if (body && typeof body === "object") {
        const record = body as { reason?: unknown; delete_token?: unknown };
        if ("reason" in record) reason = String(record.reason ?? "");
        if (typeof record.delete_token === "string") deleteToken = record.delete_token;
      }
    } else {
      const form = await req.formData();
      reason = String(form.get("reason") ?? "");
      const token = form.get("delete_token");
      if (typeof token === "string" && token) deleteToken = token;
    }
    const result = await reportNeed(id, { reason, ipHash: hashClient(req), deleteToken }, deps);
    if (type.includes("application/json")) return json(result);
    const location = result.hidden ? "/?report=hidden" : "/?report=review";
    return new Response(null, { status: 303, headers: { location } });
  } catch (error) {
    return errorResponse(error);
  }
}

export function OPTIONS() {
  return emptyOptions();
}
