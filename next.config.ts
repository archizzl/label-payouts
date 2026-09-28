import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@electric-sql/pglite", "pg", "better-sqlite3"],
  experimental: {
    // Label-level Bandcamp exports can be several MB.
    serverActions: { bodySizeLimit: "50mb" },
  },
};

export default nextConfig;
