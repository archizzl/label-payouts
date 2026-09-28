import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
      // Server modules import "server-only", which refuses to load outside Next's server build.
      "server-only": resolve(import.meta.dirname, "test/stubs/server-only.ts"),
    },
  },
});
