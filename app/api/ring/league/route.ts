import { emptyOptions, errorResponse, json } from "../../../../lib/http";
import { defaultDeps } from "../../../../lib/service";
import { league } from "../../../../lib/ring/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The practice league from real closed rounds. ?lab=1 also shows our own lab runs, flagged. */
export async function GET(req: Request) {
  try {
    const lab = new URL(req.url).searchParams.get("lab") === "1";
    const deps = await defaultDeps();
    return json(await league(deps.store, { includeLab: lab }), 200, { cors: "read" });
  } catch (error) {
    return errorResponse(error, "read");
  }
}

export function OPTIONS() {
  return emptyOptions("read");
}
