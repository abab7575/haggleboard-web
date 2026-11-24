import { emptyOptions, errorResponse, json } from "../../../../lib/http";
import { defaultDeps } from "../../../../lib/service";
import { waitForRound } from "../../../../lib/ring/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A practice round, public view. ?wait=N waits up to N seconds (max 25) for the next move. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "No practice round with that id." }, 404, { cors: "read" });
    const wait = Number(new URL(req.url).searchParams.get("wait") ?? 0) || 0;
    const deps = await defaultDeps();
    return json(await waitForRound(id, { store: deps.store }, wait), 200, { cors: "read" });
  } catch (error) {
    return errorResponse(error, "read");
  }
}

export function OPTIONS() {
  return emptyOptions("read");
}
