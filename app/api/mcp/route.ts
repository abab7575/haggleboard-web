import { getStore } from "../../../lib/db";
import { errorResponse, emptyOptions } from "../../../lib/http";
import { assertWithinRateLimit } from "../../../lib/rate-limit";
import { handleMcpRequest } from "../../../mcp/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function limited(req: Request): Promise<Response | null> {
  try {
    await assertWithinRateLimit(req, await getStore());
    return null;
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(req: Request) {
  const blocked = await limited(req);
  if (blocked) return blocked;
  return handleMcpRequest(req);
}

export async function POST(req: Request) {
  const blocked = await limited(req);
  if (blocked) return blocked;
  return handleMcpRequest(req);
}

export async function DELETE(req: Request) {
  const blocked = await limited(req);
  if (blocked) return blocked;
  return handleMcpRequest(req);
}

export function OPTIONS() {
  return emptyOptions();
}
