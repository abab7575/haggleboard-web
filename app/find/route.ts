import { findResponse } from "../../lib/find-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One-address posting: GET /find?q=... (lib/find.ts). HTML, or JSON with Accept: application/json. */
export function GET(req: Request) {
  return findResponse(req, false);
}

export function HEAD(req: Request) {
  return findResponse(req, false);
}
