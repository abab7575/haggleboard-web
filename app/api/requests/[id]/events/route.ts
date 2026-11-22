import { emptyOptions, errorResponse, HttpError, json } from "../../../../../lib/http";
import { defaultDeps } from "../../../../../lib/service";
import { publicStream } from "../../../../../lib/stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The public event stream as plain JSON, for polling. Public fields only (lib/stream.ts).
 * `?after=<seq>` returns only events with a higher seq.
 */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "No stored request with that id");
    const stream = await publicStream((await defaultDeps()).store, id);
    if (!stream) throw new HttpError(404, "No stored request with that id");
    const after = Number(new URL(req.url).searchParams.get("after") ?? "0");
    const events = Number.isFinite(after) && after > 0 ? stream.events.filter((event) => event.seq > after) : stream.events;
    return json({ ...stream, events, poll_after_ms: stream.status === "closed" ? null : 2000 }, 200, { cors: "read" });
  } catch (error) {
    return errorResponse(error, "read");
  }
}

export function OPTIONS() {
  return emptyOptions("read");
}
