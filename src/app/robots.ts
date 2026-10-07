import type { MetadataRoute } from "next";

/** A private app: ask search engines to stay out entirely. */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
