import type { MetadataRoute } from "next";
import { defaultDeps } from "../lib/service";
import { sitemapEntries } from "../lib/sitemap";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const deps = await defaultDeps();
  return sitemapEntries(deps.store, await deps.loadVariants(), process.env.SITE_URL?.trim() || "https://haggleboard.com");
}
