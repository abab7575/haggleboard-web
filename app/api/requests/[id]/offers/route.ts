import { emptyOptions, errorResponse, json } from "../../../../../lib/http";
import { defaultDeps, getOffers } from "../../../../../lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public view by default. Send the delete_token from POST /api/requests in
 * X-HaggleBoard-Delete-Token to get the poster's private view (held order comparison, store offers).
 */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const token = req.headers.get("x-haggleboard-delete-token")?.trim() || undefined;
    const result = await getOffers({ request_id: id, delete_token: token }, await defaultDeps());
    return json(result, 200, { cors: "read" });
  } catch (error) {
    return errorResponse(error, "read");
  }
}

export function OPTIONS() {
  return emptyOptions("read");
}
