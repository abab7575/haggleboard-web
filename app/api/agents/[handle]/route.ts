import { emptyOptions, errorResponse, HttpError, json } from "../../../../lib/http";
import { defaultDeps, handleSchema } from "../../../../lib/service";
import { agentScorecard } from "../../../../lib/stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Scorecard data for an agent that posted with an optional public `handle`. Bands only, no amounts. */
export async function GET(_req: Request, context: { params: Promise<{ handle: string }> }) {
  try {
    const { handle } = await context.params;
    const parsed = handleSchema.safeParse(decodeURIComponent(handle));
    if (!parsed.success) throw new HttpError(404, "No agent with that handle");
    const card = await agentScorecard((await defaultDeps()).store, parsed.data);
    if (!card) throw new HttpError(404, "No agent with that handle");
    return json(card, 200, { cors: "read" });
  } catch (error) {
    return errorResponse(error, "read");
  }
}

export function OPTIONS() {
  return emptyOptions("read");
}
