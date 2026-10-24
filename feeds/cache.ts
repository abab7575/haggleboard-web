import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sanitizeDomain } from "./host.js";

export type CacheRecord = {
  url: string;
  status: number;
  body: string;
  fetched_at: string;
  final_url: string;
};

export function cachePath(dir: string, domain: string, key: string): string {
  const safeKey = key.replace(/[^a-z0-9._-]/gi, "_");
  return path.join(dir, sanitizeDomain(domain), `${safeKey}.json`);
}

export async function readCache(file: string, maxAgeMs: number, now = Date.now()): Promise<CacheRecord | null> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as CacheRecord;
    if (!parsed || typeof parsed.body !== "string" || typeof parsed.fetched_at !== "string") return null;
    const age = now - Date.parse(parsed.fetched_at);
    if (!Number.isFinite(age) || age > maxAgeMs) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeCache(file: string, record: CacheRecord): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(record));
}
