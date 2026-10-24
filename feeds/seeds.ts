import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type StoreSeed = {
  domain: string;
  region: string;
  country: string | null;
  currency: string | null;
};

const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function loadRemoved(file = defaultRemovedFile()): Set<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("removed.json must be an array of hostnames");
  }
  return new Set(parsed.map((domain) => domain.trim().toLowerCase()).filter(Boolean));
}

export function loadSeeds(file = defaultSeedFile(), removed = loadRemoved()): StoreSeed[] {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { stores?: StoreSeed[] };
  if (!parsed.stores || !Array.isArray(parsed.stores)) {
    throw new Error("Seed file must contain a stores array");
  }
  return parsed.stores.map((store) => {
    const keys = Object.keys(store);
    if (keys.some((key) => /email/i.test(key))) {
      throw new Error("Seed file must not contain email fields");
    }
    const domain = store.domain?.trim().toLowerCase();
    if (!domain || !DOMAIN.test(domain) || domain.includes("@")) {
      throw new Error("Seed file has a domain that is not a public hostname");
    }
    return {
      domain,
      region: store.region,
      country: store.country,
      currency: store.currency ? store.currency.toUpperCase() : null,
    };
  }).filter((store) => !removed.has(store.domain));
}

export function defaultSeedFile(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "seeds", "stores.json");
}

export function defaultRemovedFile(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "seeds", "removed.json");
}
