import { readFileSync } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

export function GET() {
  const text = readFileSync(path.join(process.cwd(), "llms.txt"), "utf8");
  return new Response(text, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
