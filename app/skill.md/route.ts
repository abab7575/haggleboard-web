import { readFileSync } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

/** The agent skill, served as plain Markdown. Source: skill/haggleboard/SKILL.md */
export function GET() {
  const text = readFileSync(path.join(process.cwd(), "skill", "haggleboard", "SKILL.md"), "utf8");
  return new Response(text, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}
