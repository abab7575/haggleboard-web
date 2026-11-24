/**
 * Measures how often the watcher finds the product at the stores it checks, on a fixed list of 10
 * products. Every request is posted as internal (our own traffic, never counted, never notified).
 *
 *   npx tsx scripts/hit-rate.ts --db <file.sqlite> [--out result.json]
 *
 * It makes live, polite requests through the watcher's own code (robots.txt, the bot user agent,
 * 5 seconds or more between requests, the 12-hour feed cache, the cap of 5 stores and 1 product
 * request per store). Hosts listed in PROBE_BUDGET_SPENT are never contacted: their agent endpoints
 * were already probed tonight (3 requests or fewer each), and a recorded answer stands in only where
 * one was saved (REPLAY). Those are reported separately.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openSqlite } from "../lib/db.js";
import { requestEvents, serviceContext } from "../lib/events.js";
import { defaultDeps, postRequest, type Deps } from "../lib/service.js";
import { getWatchRun } from "../lib/watch-store.js";
import { runWatch } from "../watcher/run.js";

export const HIT_RATE_PRODUCTS = [
  "womens Saucony Endorphin Speed 6 size 8",
  "mens Hoka Clifton 9 size 10",
  "womens ASICS Novablast 6 size 7",
  "mens Nike Pegasus 41 size 11",
  "mens Brooks Ghost 16 size 10",
  "womens OOFOS OOlala Luxe size 8",
  "mens Allbirds Tree Runner size 9",
  "womens New Balance 1080 v14 size 8",
  "mens Saucony Kinvara 15 size 10",
  "womens Birkenstock Arizona size 39",
];

const PROBE_BUDGET_SPENT = ["allbirds.com", "altrarunning.com", "karhu.com"];

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

async function main() {
  const dbFile = arg("--db");
  if (!dbFile) throw new Error("--db <file> is required");
  const replayDir = arg("--replay");
  const cacheOnly = process.argv.includes("--cache-only");
  process.env.DELETE_TOKEN_KEY ||= "hit-rate-local-only";
  const store = await openSqlite(dbFile);
  const base = await defaultDeps();
  const deps: Deps = { ...base, store, origin: "internal", context: { ...serviceContext("service"), internal: true } };

  const spent = (host: string) => PROBE_BUDGET_SPENT.some((d) => host === d || host.endsWith(`.${d}`));
  const notTried: string[] = [];
  const replayed: string[] = [];
  const guardedFetch = async (url: string, init: RequestInit): Promise<Response> => {
    const host = new URL(url).hostname;
    if (spent(host)) {
      const file = replayDir ? path.join(replayDir, `${host.replace(/^www\./, "")}${new URL(url).pathname.replace(/\//g, "_")}.txt`) : null;
      if (file && existsSync(file)) {
        replayed.push(url);
        return new Response(readFileSync(file, "utf8"), {
          status: 200,
          headers: { "content-type": url.endsWith("robots.txt") ? "text/plain" : "application/json" },
        });
      }
      notTried.push(url);
      throw new Error("probe budget spent for this store tonight");
    }
    // --cache-only: no new request to any store (answers come from the 12-hour cache or not at all).
    if (cacheOnly && !host.endsWith("arcreport.ai")) {
      notTried.push(url);
      throw new Error("cache-only run");
    }
    return fetch(url, init);
  };

  const rows = [];
  for (const text of HIT_RATE_PRODUCTS) {
    const posted = await postRequest({ text, auction_seconds: 30 }, deps);
    await runWatch(store, { id: posted.id, need: posted.need, origin: "internal" }, base.loadVariants, { fetch: guardedFetch });
    const events = await requestEvents(store, posted.id);
    const matched = events.filter((event) => event.type === "store.matched");
    // The watch summary has every store it asked, including answers served from the 12-hour cache
    // (the old watcher wrote no store.read for those).
    const summary = (await getWatchRun(store, posted.id))?.summary;
    const asked = (summary?.stores ?? []).filter((item) => item.status === "answered" || item.status === "no_match");
    rows.push({
      text,
      stores_matched: matched.length,
      stores_read: asked.length,
      found: asked.filter((item) => item.status === "answered").map((item) => item.store_domain),
      reads: asked.map((item) => ({ store: item.store_domain, status: item.status, route: item.route ?? "feed", reason: item.reason })),
      skipped: (summary?.stores ?? []).filter((item) => item.status === "skipped").map((item) => ({ store: item.store_domain, reason: item.reason })),
    });
    console.log(text, "->", rows.at(-1)!.found.length, "found of", asked.length, "asked");
  }
  const reads = rows.reduce((n, row) => n + row.stores_read, 0);
  const found = rows.reduce((n, row) => n + row.found.length, 0);
  const summary = {
    products: rows.length,
    products_found_somewhere: rows.filter((row) => row.found.length > 0).length,
    store_reads: reads,
    store_reads_found: found,
    per_read_hit_rate: reads ? found / reads : null,
    not_tried_probe_budget: [...new Set(notTried.map((url) => new URL(url).hostname))],
    replayed_recorded_answers: replayed.length,
    rows,
  };
  console.log(JSON.stringify({ ...summary, rows: undefined }, null, 2));
  const out = arg("--out");
  if (out) writeFileSync(out, JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
