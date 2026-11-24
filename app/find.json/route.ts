import { findResponse } from "../../lib/find-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One-address posting, always JSON: GET /find.json?q=... (lib/find.ts). */
export function GET(req: Request) {
  return findResponse(req, true);
}

export function HEAD(req: Request) {
  return findResponse(req, true);
}
