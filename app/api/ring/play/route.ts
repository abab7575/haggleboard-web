import { getStore } from "../../../../lib/db";
import { ringOneAddress } from "../../../../lib/ring/one-address";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /ring?q=... and /ring?round=... arrive here through middleware.ts. See lib/ring/one-address.ts. */
export async function GET(req: Request) {
  return ringOneAddress(req, await getStore());
}

export async function HEAD(req: Request) {
  return ringOneAddress(req, await getStore());
}
