import type { MetadataRoute } from "next";
import { robotsDocument } from "../lib/indexing";

export default function robots(): MetadataRoute.Robots {
  return robotsDocument();
}
