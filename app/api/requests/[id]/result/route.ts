import { emptyOptions, errorResponse, json } from "../../../../../lib/http";
import { defaultDeps, getResult, RESULT_MAX_WAIT_SECONDS } from "../../../../../lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * The poster's result: standing with amounts while the window is open, the winner with its
 * checkout link after it closes. Needs the delete_token in X-HaggleBoard-Delete-Token.
 * `?wait=<0-25>` waits that many seconds for the close (default 20).
 */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const token = req.headers.get("x-haggleboard-delete-token")?.trim() ?? "";
    const waitRaw = new URL(req.url).searchParams.get("wait");
    const wait = waitRaw == null ? undefined : Math.min(RESULT_MAX_WAIT_SECONDS, Math.max(0, Math.floor(Number(waitRaw) || 0)));
    const result = await getResult({ request_id: id, delete_token: token, wait_seconds: wait }, await defaultDeps());
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
}

export function OPTIONS() {
  return emptyOptions();
}
