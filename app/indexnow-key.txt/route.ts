import { indexNowEnabled, indexNowKey } from "../../lib/indexnow";

export const dynamic = "force-dynamic";

/** The IndexNow key file. 404 unless IndexNow is switched on. */
export function GET() {
  const key = indexNowKey();
  if (!indexNowEnabled() || !key) return new Response("Not found", { status: 404 });
  return new Response(key, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
