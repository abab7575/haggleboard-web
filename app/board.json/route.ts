import { emptyOptions, errorResponse, json } from "../../lib/http";
import { boardFeed, defaultDeps } from "../../lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public JSON feed of the board. Same public fields as /board, nothing private. */
export async function GET() {
  try {
    return json(await boardFeed(await defaultDeps()), 200, { cors: "read" });
  } catch (error) {
    return errorResponse(error, "read");
  }
}

export function OPTIONS() {
  return emptyOptions("read");
}
