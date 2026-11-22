import { openStore } from "../lib/db.js";
import { pendingWatchRequests } from "../lib/watch-store.js";
import { defaultDeps } from "../lib/service.js";
import { USER_AGENT } from "../feeds/constants.js";
import { WATCH_MAX_STORE_FETCHES, WATCH_MAX_STORES, WATCH_PICKUP_WINDOW_MS } from "./constants.js";
import { runWatch, watcherScheduler } from "./run.js";

/**
 * npm run watch -- work --max 5     watch up to 5 pending requests, oldest first
 * npm run watch -- work --once      watch one
 *
 * One worker at a time. The crawler's rules apply to every store fetch, and one request never makes
 * more than WATCH_MAX_STORE_FETCHES store fetches.
 */
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "work") {
    console.log(`HaggleBoard watcher
User-Agent: ${USER_AGENT}
At most ${WATCH_MAX_STORES} stores and ${WATCH_MAX_STORE_FETCHES} store fetches per request.

  npm run watch -- work --once
  npm run watch -- work --max 5`);
    return;
  }
  const maxIndex = rest.indexOf("--max");
  const max = rest.includes("--once") ? 1 : maxIndex >= 0 ? Math.max(1, Number(rest[maxIndex + 1]) || 1) : 1;
  const store = await openStore();
  const deps = { ...(await defaultDeps()), store };
  const since = new Date(Date.now() - WATCH_PICKUP_WINDOW_MS).toISOString();
  const ids = await pendingWatchRequests(store, since, max);
  if (ids.length === 0) console.log("nothing to watch");
  const scheduler = watcherScheduler();
  for (const id of ids) {
    const row = await store.getRequest(id);
    if (!row) continue;
    const result = await runWatch(
      store,
      { id, need: JSON.parse(row.need_json), origin: row.origin ?? "outside" },
      deps.loadVariants,
      { scheduler },
    );
    const summary = result.summary;
    console.log(
      `${id} stores=${summary?.stores.length ?? 0} fetches=${summary?.store_fetches ?? 0} arc_calls=${summary?.arc_calls ?? 0} offers=${result.offers.length}${summary?.stopped ? ` stopped=${summary.stopped}` : ""}`,
    );
    for (const item of summary?.stores ?? []) {
      console.log(`  ${item.status} ${item.store_domain} (${item.source})${item.reason ? `: ${item.reason}` : ""}`);
    }
  }
  await store.close();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "watch failed");
  process.exitCode = 1;
});
