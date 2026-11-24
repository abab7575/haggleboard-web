import { getStore } from "../../../lib/db";
import { withRequestHooks } from "../../../lib/inline-watch";
import { defaultDeps } from "../../../lib/service";
import { errorResponse, emptyOptions } from "../../../lib/http";
import { assertWithinRateLimit, PUBLIC_BUCKET, RING_BUCKET, type RateBucket } from "../../../lib/rate-limit";
import { handleMcpRequest } from "../../../mcp/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Practice-ring calls (tools/call for ring_*) count against their own bucket: a round is two
 * minutes of back and forth with made-up stores and makes no outside request. Everything else on
 * this endpoint keeps the public limit.
 */
async function bucketFor(req: Request): Promise<RateBucket> {
  if (req.method !== "POST") return PUBLIC_BUCKET;
  try {
    const body = (await req.clone().json()) as unknown;
    const calls = Array.isArray(body) ? body : [body];
    const ring = calls.length > 0 && calls.every((call) => {
      const c = call as { method?: unknown; params?: { name?: unknown } };
      return c.method === "tools/call" && typeof c.params?.name === "string" && c.params.name.startsWith("ring_");
    });
    return ring ? RING_BUCKET : PUBLIC_BUCKET;
  } catch {
    return PUBLIC_BUCKET;
  }
}

async function limited(req: Request): Promise<Response | null> {
  try {
    await assertWithinRateLimit(req, await getStore(), Date.now(), await bucketFor(req));
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
  return handleMcpRequest(req, withRequestHooks(await defaultDeps(), req, "mcp"));
}

export async function DELETE(req: Request) {
  const blocked = await limited(req);
  if (blocked) return blocked;
  return handleMcpRequest(req);
}

export function OPTIONS() {
  return emptyOptions();
}
