// Writes the whole events table to a dated JSONL file: exports/events-YYYY-MM-DD.jsonl (gitignored).
// Read-only against the database. Safe to run nightly: it writes to a temp file and renames it into
// place, so a crash never leaves a half-written export, and a second run the same day replaces it.
// THE FILE INCLUDES PRIVATE FIELDS (held orders, caps, bid amounts, floors). Store it like the database.
//
//   npm run export-events
//   npm run export-events -- --out /path/to/backups
import { createWriteStream, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";
import { openStore } from "../lib/db.js";
import { allEvents } from "../lib/events.js";

export async function exportEvents(outDir: string, env: NodeJS.ProcessEnv = process.env, now = new Date()): Promise<{ file: string; rows: number } | null> {
  if (!env.DATABASE_URL?.trim() && env.VERCEL) return null;
  const store = await openStore(env);
  try {
    if (store.kind === "unavailable") return null;
    mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `events-${now.toISOString().slice(0, 10)}.jsonl`);
    const temp = `${file}.partial-${process.pid}`;
    const out = createWriteStream(temp, { encoding: "utf8" });
    let rows = 0;
    for await (const row of allEvents(store)) {
      if (!out.write(`${JSON.stringify(row)}\n`)) await new Promise((resolve) => out.once("drain", resolve));
      rows += 1;
    }
    out.end();
    await finished(out);
    renameSync(temp, file);
    return { file, rows };
  } finally {
    await store.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("scripts", "export-events.ts"));
if (isMain) {
  const flag = process.argv.indexOf("--out");
  const outDir = flag >= 0 && process.argv[flag + 1] ? path.resolve(process.argv[flag + 1]!) : path.join(process.cwd(), "exports");
  const result = await exportEvents(outDir);
  if (!result) {
    console.log("No database configured: nothing is stored, so there is nothing to export.");
  } else {
    console.log(`wrote ${result.rows} events to ${result.file}`);
  }
}
