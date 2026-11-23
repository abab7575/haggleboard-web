import type { MetadataRoute } from "next";
import type { Store } from "./db.js";
import { questions } from "./questions.js";
import { storesWithPages } from "./store-page.js";
import type { CatalogVariant } from "../referee/types.js";

export const SITEMAP_REQUESTS = 500;

/**
 * Public pages only: home, board, question pages, request pages of recent OUTSIDE requests that are
 * still public (not hidden, not past retention), and store pages (never removed stores).
 */
export async function sitemapEntries(
  store: Store,
  variants: CatalogVariant[],
  site: string,
  now = Date.now(),
  removed?: Set<string>,
): Promise<MetadataRoute.Sitemap> {
  const base = site.replace(/\/$/, "");
  const entries: MetadataRoute.Sitemap = [
    { url: `${base}/`, changeFrequency: "daily" },
    { url: `${base}/board`, changeFrequency: "hourly" },
    ...questions.map((question) => ({ url: `${base}/q/${question.slug}`, changeFrequency: "daily" as const })),
  ];
  if (store.kind !== "unavailable") {
    const outside = new Set(
      (await store.select("SELECT request_id FROM events WHERE type = 'request.posted' AND internal = 0 AND at >= ?", [
        new Date(now - 30 * 86_400_000).toISOString(),
      ])).map((row) => String(row.request_id)),
    );
    // Requests where a fictional test store took part (TEST_STORES=1) are never listed.
    const tested = new Set(
      (await store.select("SELECT DISTINCT request_id FROM events WHERE request_id IS NOT NULL AND public LIKE ?", ['%"test":true%'])).map(
        (row) => String(row.request_id),
      ),
    );
    for (const row of await store.listRequests(SITEMAP_REQUESTS)) {
      if (outside.has(row.id) && !tested.has(row.id)) {
        entries.push({ url: `${base}/r/${row.id}`, lastModified: row.created_at, changeFrequency: "hourly" });
      }
    }
  }
  for (const domain of await storesWithPages(store, variants, now, removed)) {
    entries.push({ url: `${base}/s/${domain}`, changeFrequency: "daily" });
  }
  return entries;
}
