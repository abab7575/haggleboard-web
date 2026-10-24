import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CatalogVariant } from "../referee/types.js";

export type FixtureFile = {
  generated_by?: string;
  user_agent?: string;
  crawled_at?: string | null;
  synthetic?: boolean;
  note?: string;
  variants: CatalogVariant[];
  stores?: unknown[];
};

export function defaultFixturePath(): string {
  const sample = path.join(process.cwd(), "fixtures", "sample-crawl.json");
  if (existsSync(sample)) return sample;
  return path.join(process.cwd(), "fixtures", "mini-catalog.json");
}

export function readFixture(file = defaultFixturePath()): FixtureFile {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as FixtureFile;
  return {
    ...parsed,
    variants: Array.isArray(parsed.variants) ? parsed.variants : [],
    crawled_at: parsed.crawled_at ?? null,
    synthetic: parsed.synthetic === true,
  };
}
