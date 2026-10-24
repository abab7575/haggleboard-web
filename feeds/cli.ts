import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { crawlStore, stopsTheRun, type StoreCrawlResult } from "./crawl.js";
import {
  CACHE_TTL_MS,
  DEFAULT_GLOBAL_INTERVAL_MS,
  DEFAULT_HOST_INTERVAL_MS,
  resolveGlobalInterval,
  resolveHostInterval,
  USER_AGENT,
} from "./constants.js";
import { sleep } from "./politeness.js";
import { claimNext, domainBlocked, readQueue, withQueueLock, writeQueue, type CrawlJob } from "./queue.js";
import { loadSeeds, type StoreSeed } from "./seeds.js";
import { buildFixture } from "./snapshot.js";
import { importVariants } from "../lib/service.js";
import { openStore } from "../lib/db.js";
import { readFixture } from "../lib/catalog.js";

const queuePath = path.join(process.cwd(), "feeds", "jobs", "queue.json");
const cacheDir = path.join(process.cwd(), "feeds", "cache");

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  if (!command || command === "help" || flags.has("help")) {
    console.log(help());
    return;
  }
  if (command === "enqueue") return enqueue(flags);
  if (command === "work") return work(flags);
  if (command === "sample") return sample(flags);
  if (command === "import") return importFile(flags);
  throw new Error(`Unknown command: ${command}`);
}

function help() {
  return `HaggleBoard crawl
User-Agent: ${USER_AGENT}
Default pace: ${DEFAULT_HOST_INTERVAL_MS}ms per store, ${DEFAULT_GLOBAL_INTERVAL_MS}ms between any requests.
The pace cannot be set below the built-in floor.

  npm run crawl -- enqueue --all --pages 1 --limit 30
  npm run crawl -- enqueue --domain pacersrunning.com --pages 1
  npm run crawl -- work --once
  npm run crawl -- work --max 3 --import
  npm run crawl -- sample --count 3 --pages 2 --limit 30 --out fixtures/sample-crawl.json
  npm run crawl -- import --file fixtures/sample-crawl.json

Jobs live in feeds/jobs/queue.json. The queue file is locked while a job is claimed or finished. Run one worker.
A 429 or a bot challenge stops that store for at least a day (a week for a challenge, 401, or 403). A second 429 or challenge stops the whole run.`;
}

async function enqueue(flags: Flags) {
  const pages = numberFlag(flags, "pages", 1);
  const limit = numberFlag(flags, "limit", 30);
  const seeds = selectSeeds(flags);
  await withQueueLock(path.dirname(queuePath), async () => {
    const queue = await readQueue(queuePath);
    const now = new Date().toISOString();
    for (const seed of seeds) {
      if (domainBlocked(queue, seed.domain, now)) {
        console.log(`skip ${seed.domain} (backoff)`);
        continue;
      }
      if (queue.jobs.some((job) => job.domain === seed.domain && (job.status === "pending" || job.status === "running"))) {
        console.log(`skip ${seed.domain} (already queued)`);
        continue;
      }
      queue.jobs.push(newJob(seed.domain, pages, limit, now));
      console.log(`queued ${seed.domain}`);
    }
    await writeQueue(queuePath, queue);
  });
}

async function work(flags: Flags) {
  const max = flags.has("once") ? 1 : numberFlag(flags, "max", 1);
  const out = flags.get("out");
  const collected: StoreCrawlResult[] = [];
  let hardStops = 0;
  for (let n = 0; n < max; n++) {
    if (hardStops >= 2) break;
    const job = await withQueueLock(path.dirname(queuePath), async () => {
      const queue = await readQueue(queuePath);
      const now = new Date();
      const stale = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
      const claimed = claimNext(queue, now.toISOString(), stale);
      if (claimed) await writeQueue(queuePath, queue);
      return claimed;
    });
    if (!job) {
      console.log("queue empty");
      break;
    }
    const result = await safeRun(job);
    collected.push(result);
    await finishJob(job, result);
    if (flags.has("import") && result.variants.length > 0) {
      const store = await openStore();
      await importVariants(result.variants, store);
      await store.close();
      console.log(`imported ${result.variants.length} variants from ${job.domain}`);
    }
    if (stopsTheRun(result.stop_reason)) {
      hardStops += 1;
      console.error(`${result.stop_reason} from ${job.domain}; that store is backed off`);
      if (hardStops >= 2) {
        console.error("Stopping the run: a second 429 or challenge");
        break;
      }
    }
    if (n < max - 1 && hardStops < 2) await sleep(resolveGlobalInterval(undefined, false));
  }
  if (out) await writeSnapshot(out, collected);
}

async function sample(flags: Flags) {
  const count = numberFlag(flags, "count", 3);
  const pages = numberFlag(flags, "pages", 1);
  const limit = numberFlag(flags, "limit", 30);
  const out = flags.get("out") ?? path.join(process.cwd(), "fixtures", "sample-crawl.json");
  const seeds = loadSeeds();
  const collected: StoreCrawlResult[] = [];
  let hardStops = 0;
  for (const seed of seeds) {
    if (collected.filter((item) => item.pages_fetched > 0 && item.variants.length > 0).length >= count) break;
    if (hardStops >= 2) {
      console.error("Stopping sample: a second 429 or challenge");
      break;
    }
    const queue = await readQueue(queuePath);
    if (domainBlocked(queue, seed.domain, new Date().toISOString())) {
      console.log(`skip ${seed.domain} (backoff)`);
      continue;
    }
    const job = newJob(seed.domain, pages, limit, new Date().toISOString());
    await remember(job);
    const result = await safeRun(job);
    await finishJob(job, result);
    if (stopsTheRun(result.stop_reason)) {
      hardStops += 1;
      console.error(`${result.stop_reason} from ${seed.domain}; that store is stopped`);
      if (hardStops >= 2) {
        console.error("Stopping sample: a second 429 or challenge");
        break;
      }
      continue;
    }
    if (result.pages_fetched > 0 && result.variants.length > 0) collected.push(result);
    else console.log(`no listings from ${seed.domain} (${result.stop_reason ?? "empty"})`);
    const filled = collected.filter((item) => item.pages_fetched > 0 && item.variants.length > 0).length;
    if (filled < count && hardStops < 2) await sleep(resolveGlobalInterval(undefined, false));
  }
  await writeSnapshot(out, collected);
  const ok = collected.length;
  console.log(`sample stores with listings: ${ok}`);
  if (ok === 0) process.exitCode = 1;
}

async function importFile(flags: Flags) {
  const file = flags.get("file");
  if (!file) throw new Error("--file is required");
  const fixture = readFixture(file);
  const store = await openStore();
  const count = await importVariants(fixture.variants, store);
  await store.close();
  console.log(`imported ${count} variants into ${store.kind === "unavailable" ? "nowhere" : "the database"}`);
}

async function runJob(job: CrawlJob): Promise<StoreCrawlResult> {
  const seed = loadSeeds().find((item) => item.domain === job.domain) ?? {
    domain: job.domain,
    region: "other",
    country: null,
    currency: null,
  };
  console.log(`crawl ${seed.domain} pages=${job.pages} limit=${job.limit}`);
  const result = await crawlStore({
    seed,
    pages: job.pages,
    limit: job.limit,
    cacheDir,
    cacheTtlMs: CACHE_TTL_MS,
    perHostMs: resolveHostInterval(undefined, false),
    globalMs: resolveGlobalInterval(undefined, false),
  });
  for (const request of result.requests) {
    console.log(
      `${request.at} ${request.status ?? "ERR"} wait=${request.waited_ms}ms cache=${request.from_cache} ${request.url}`,
    );
  }
  console.log(
    `${seed.domain} pages=${result.pages_fetched} variants=${result.variants.length} stopped=${result.stopped} ${result.stop_reason ?? ""}`.trim(),
  );
  return result;
}

async function finishJob(job: CrawlJob, result: StoreCrawlResult) {
  await withQueueLock(path.dirname(queuePath), async () => {
    const queue = await readQueue(queuePath);
    const found = queue.jobs.find((item) => item.id === job.id);
    const target = found ?? job;
    if (!found) queue.jobs.push(target);
    target.status = result.stopped ? "stopped" : "done";
    target.stop_reason = result.stop_reason ?? undefined;
    target.backoff_until = result.backoff_until ?? undefined;
    target.pages_fetched = result.pages_fetched;
    target.variant_count = result.variants.length;
    target.updated_at = new Date().toISOString();
    await writeQueue(queuePath, queue);
  });
}

async function remember(job: CrawlJob) {
  await withQueueLock(path.dirname(queuePath), async () => {
    const queue = await readQueue(queuePath);
    queue.jobs.push({ ...job, status: "running" });
    await writeQueue(queuePath, queue);
  });
}

async function writeSnapshot(file: string, results: StoreCrawlResult[]) {
  await mkdir(path.dirname(file), { recursive: true });
  const fixture = buildFixture(results, new Date().toISOString());
  await writeFile(file, JSON.stringify(fixture, null, 2));
  console.log(`wrote ${file} (${fixture.variants.length} variants)`);
}

function newJob(domain: string, pages: number, limit: number, now: string): CrawlJob {
  return {
    id: `${domain}-${now.slice(0, 19).replace(/[:T]/g, "")}`,
    domain,
    pages,
    limit,
    status: "pending",
    created_at: now,
    updated_at: now,
  };
}

function selectSeeds(flags: Flags): StoreSeed[] {
  const seeds = loadSeeds();
  if (flags.has("all")) return seeds;
  const domains = flags.getAll("domain");
  if (domains.length === 0) throw new Error("Pass --all or --domain");
  return domains.map((domain) => {
    const found = seeds.find((seed) => seed.domain === domain.toLowerCase());
    if (!found) throw new Error(`Unknown seed domain: ${domain}`);
    return found;
  });
}

type Flags = {
  has: (name: string) => boolean;
  get: (name: string) => string | undefined;
  getAll: (name: string) => string[];
};

function parseFlags(args: string[]): Flags {
  const values = new Map<string, string[]>();
  const switches = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg?.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) switches.add(name);
    else {
      const list = values.get(name) ?? [];
      list.push(next);
      values.set(name, list);
      i += 1;
    }
  }
  return {
    has: (name) => switches.has(name) || values.has(name),
    get: (name) => values.get(name)?.at(-1),
    getAll: (name) => values.get(name) ?? [],
  };
}

function numberFlag(flags: Flags, name: string, fallback: number): number {
  const raw = flags.get(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number`);
  return value;
}

async function safeRun(job: CrawlJob): Promise<StoreCrawlResult> {
  try {
    return await runJob(job);
  } catch (error) {
    console.error(`${job.domain} failed`);
    console.error(error instanceof Error ? error.message : "error");
    return {
      domain: job.domain,
      country: null,
      region: null,
      currency: null,
      shop_origin: null,
      pages_fetched: 0,
      robots_allowed: false,
      stopped: true,
      stop_reason: "error",
      backoff_until: null,
      requests: [],
      variants: [],
    };
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "crawl failed");
  process.exitCode = 1;
});
