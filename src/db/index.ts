import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzleNodePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { Pool } from "pg";
import * as schema from "./schema";

/*
 * Postgres, from DATABASE_URL: a hosted one (Neon, Supabase, Railway…), or the local one that
 * `npm run dev` starts (data/postgres). Tests set PGLITE_DIR=memory:// instead, for a fresh
 * in-memory Postgres each run. (PGlite is never used for real data: it must only ever be opened by
 * one process, and Next's dev server runs several.)
 */

export type DB = NodePgDatabase<typeof schema>;

const migrationsFolder = join(process.cwd(), "drizzle");

function open(): { db: DB; migrate: () => Promise<void> } {
  const url = process.env.DATABASE_URL;
  if (url) {
    const db = drizzleNodePg(new Pool({ connectionString: url }), { schema });
    return { db, migrate: () => migrateNodePg(db, { migrationsFolder }) };
  }
  const dir = process.env.PGLITE_DIR;
  if (!dir) {
    throw new Error("DATABASE_URL isn't set. Start the app with `npm run dev`, which runs a local database, or set DATABASE_URL.");
  }
  if (!dir.includes("://")) mkdirSync(dir, { recursive: true });
  const db = drizzlePglite(new PGlite(dir), { schema });
  return {
    // Same query API as node-postgres for everything we use.
    db: db as unknown as DB,
    migrate: () => migratePglite(db, { migrationsFolder }),
  };
}

// One connection per server process: survives dev hot reloads, and PGlite must never be opened twice.
const state = globalThis as unknown as { __labelDb?: ReturnType<typeof open>; __labelReady?: Promise<void> };
const conn = (state.__labelDb ??= open());

export const db: DB = conn.db;

/**
 * Resolves once the schema is up to date. The server awaits it at startup (src/instrumentation.ts);
 * scripts and tests await it before their first query.
 */
export const ready: Promise<void> = (state.__labelReady ??= conn.migrate());

export { schema };
