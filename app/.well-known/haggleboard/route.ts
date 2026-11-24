import { discoveryDocument } from "../../../lib/discovery";
import { json } from "../../../lib/http";

export const dynamic = "force-dynamic";

/** Discovery document for this board (lib/discovery.ts). */
export function GET() {
  return json(discoveryDocument(process.env.SITE_URL?.trim() || "https://haggleboard.com"), 200, {
    cors: "read",
    headers: { "cache-control": "public, max-age=3600" },
  });
}
