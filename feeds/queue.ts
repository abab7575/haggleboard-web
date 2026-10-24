import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type JobStatus = "pending" | "running" | "done" | "stopped";

export type CrawlJob = {
  id: string;
  domain: string;
  pages: number;
  limit: number;
  status: JobStatus;
  stop_reason?: string;
  backoff_until?: string;
  created_at: string;
  updated_at: string;
  pages_fetched?: number;
  variant_count?: number;
};

export type QueueFile = { version: 1; jobs: CrawlJob[] };

export function emptyQueue(): QueueFile {
  return { version: 1, jobs: [] };
}

export async function readQueue(file: string): Promise<QueueFile> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as QueueFile;
    if (!parsed || !Array.isArray(parsed.jobs)) return emptyQueue();
    return { version: 1, jobs: parsed.jobs };
  } catch {
    return emptyQueue();
  }
}

export async function writeQueue(file: string, queue: QueueFile): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(queue, null, 2));
  await rename(tmp, file);
}

export function domainBlocked(queue: QueueFile, domain: string, nowIso: string): boolean {
  return queue.jobs.some(
    (job) => job.domain === domain && job.backoff_until != null && job.backoff_until > nowIso,
  );
}

/** Marks the next pending job running. Caller must persist the queue before crawling. */
export function claimNext(queue: QueueFile, nowIso: string, staleBeforeIso: string): CrawlJob | null {
  for (const job of queue.jobs) {
    if (job.status === "running" && job.updated_at < staleBeforeIso) {
      job.status = "pending";
    }
  }
  const next = queue.jobs.find((job) => job.status === "pending" && !domainBlocked(queue, job.domain, nowIso));
  if (!next) return null;
  next.status = "running";
  next.updated_at = nowIso;
  return next;
}

export async function withQueueLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dir, { recursive: true });
  const lockPath = path.join(dir, "queue.lock");
  const handle = await acquire(lockPath);
  try {
    return await fn();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

async function acquire(lockPath: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(String(process.pid));
      return handle;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (await lockIsStale(lockPath)) {
        await rm(lockPath, { force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Could not lock the crawl queue. Another worker may be running.");
}

async function lockIsStale(lockPath: string): Promise<boolean> {
  try {
    const pid = Number(await readFile(lockPath, "utf8"));
    if (!pid) return true;
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}
