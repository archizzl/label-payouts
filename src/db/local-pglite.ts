import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema";

/*
 * Tests only (vitest.config.ts puts this in place of local.ts): a fresh in-memory Postgres per test
 * file, from PGLITE_DIR=memory://. Never used for real data: PGlite must only ever be opened by one
 * process, and Next's dev server runs several.
 */
export function openLocal(): { db: NodePgDatabase<typeof schema>; migrate: () => Promise<void> } {
  const dir = process.env.PGLITE_DIR ?? "memory://";
  if (!dir.includes("://")) mkdirSync(dir, { recursive: true });
  const db = drizzle(new PGlite(dir), { schema });
  return {
    // Same query API as node-postgres for everything we use.
    db: db as unknown as NodePgDatabase<typeof schema>,
    migrate: () => migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") }),
  };
}
