import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/*
 * `npm run abel:eval`: talk to Abel (with the real AI service) about the local data, read-only. Not
 * part of `npx vitest run`: it calls the AI service and needs `npm run dev`'s database running.
 * See src/server/abel/__evals__/abel.eval.ts.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
      "server-only": resolve(import.meta.dirname, "test/stubs/server-only.ts"),
    },
  },
  test: {
    include: ["src/server/abel/__evals__/*.eval.ts"],
    testTimeout: 600_000,
    hookTimeout: 60_000,
  },
});
