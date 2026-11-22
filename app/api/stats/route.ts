import { emptyOptions, errorResponse, json } from "../../../lib/http";
import { defaultDeps } from "../../../lib/service";
import { publicStats } from "../../../lib/stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public aggregates from the event log. Outside traffic only. */
export async function GET() {
  try {
    const store = (await defaultDeps()).store;
    if (store.kind === "unavailable") {
      return json({ stored: false, note: "This deployment has no DATABASE_URL, so nothing is stored and there is nothing to count." }, 200, { cors: "read" });
    }
    return json(await publicStats(store), 200, { cors: "read" });
  } catch (error) {
    return errorResponse(error, "read");
  }
}

export function OPTIONS() {
  return emptyOptions("read");
}
