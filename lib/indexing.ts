import type { Metadata, MetadataRoute } from "next";
import { DISCLAIMER } from "./copy.js";

/** Index only when HB_PUBLIC=1 on a production deploy. Vercel previews stay noindex. */
export function indexingAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.HB_PUBLIC?.trim() !== "1") return false;
  if (env.NODE_ENV !== "production") return false;
  if (env.VERCEL === "1" && env.VERCEL_ENV !== "production") return false;
  return true;
}

export function robotsDocument(env: NodeJS.ProcessEnv = process.env): MetadataRoute.Robots {
  return indexingAllowed(env)
    ? { rules: [{ userAgent: "*", allow: "/" }] }
    : { rules: [{ userAgent: "*", disallow: "/" }] };
}

export function rootMetadata(env: NodeJS.ProcessEnv = process.env): Metadata {
  const listed = indexingAllowed(env);
  return {
    metadataBase: new URL(env.SITE_URL?.trim() || "https://haggleboard.com"),
    title: {
      default: "HaggleBoard",
      template: "%s · HaggleBoard",
    },
    description: DISCLAIMER,
    robots: listed ? { index: true, follow: true } : { index: false, follow: false },
  };
}
