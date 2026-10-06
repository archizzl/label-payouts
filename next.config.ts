import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@electric-sql/pglite", "pg", "better-sqlite3"],
  // The import page moved under Sales.
  async redirects() {
    return [{ source: "/import", destination: "/sales/import", permanent: false }];
  },
  experimental: {
    // Label-level Bandcamp exports can be several MB.
    serverActions: { bodySizeLimit: "50mb" },
  },
};

export default nextConfig;
