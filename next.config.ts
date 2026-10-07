import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@electric-sql/pglite", "pg", "better-sqlite3"],
  // pg loads its Cloudflare socket support only when running on Workers, so tracing doesn't see it.
  outputFileTracingIncludes: { "/**": ["./node_modules/pg-cloudflare/**"] },
  // The import page moved under Sales.
  async redirects() {
    return [{ source: "/import", destination: "/sales/import", permanent: false }];
  },
  // Basic protection for a site on the public internet: no framing (clickjacking), no MIME sniffing,
  // no leaking page addresses to other sites, no camera/mic/location, and not in search engines.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
  experimental: {
    // Label-level Bandcamp exports can be several MB.
    serverActions: { bodySizeLimit: "50mb" },
  },
};

export default nextConfig;
