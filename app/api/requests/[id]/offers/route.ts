import { emptyOptions, errorResponse, json } from "../../../../../lib/http";
import { defaultDeps, getOffers } from "../../../../../lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const result = await getOffers({ request_id: id }, await defaultDeps());
    return json(result, 200, { cors: "read" });
  } catch (error) {
    return errorResponse(error, "read");
  }
}

export function OPTIONS() {
  return emptyOptions("read");
}
