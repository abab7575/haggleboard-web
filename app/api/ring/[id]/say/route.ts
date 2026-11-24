import { emptyOptions, errorResponse, json, readJson } from "../../../../../lib/http";
import { eventContext } from "../../../../../lib/events";
import { assertWithinRateLimit, RING_BUCKET } from "../../../../../lib/rate-limit";
import { defaultDeps } from "../../../../../lib/service";
import { say } from "../../../../../lib/ring/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "No practice round with that id." }, 404);
    const deps = await defaultDeps();
    await assertWithinRateLimit(req, deps.store, Date.now(), RING_BUCKET);
    const body = await readJson(req);
    return json(await say(id, body, { store: deps.store, context: eventContext(req, "api") }), 200);
  } catch (error) {
    return errorResponse(error);
  }
}

export function OPTIONS() {
  return emptyOptions();
}
