import "server-only";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

const migrationsFolder = join(process.cwd(), "drizzle");
const journal = join(migrationsFolder, "meta", "_journal.json");

function open() {
  const file = process.env.LABEL_DB ?? join(process.cwd(), "data", "label.db");
  mkdirSync(dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

type DB = ReturnType<typeof open>;
const state = globalThis as unknown as { __labelDb?: DB; __labelMigrated?: number; __labelCheckedAt?: number };

/** One connection per server process (survives dev hot reloads). */
const conn: DB = state.__labelDb ?? (state.__labelDb = open());

/**
 * Apply any new migrations. A running dev server keeps its connection across code changes, so
 * rather than relying on this module being reloaded, we notice when the migrations journal
 * changes (checked at most once a second) and migrate then. Already-applied migrations are skipped.
 */
function ensureMigrated() {
  const now = Date.now();
  if (state.__labelCheckedAt && now - state.__labelCheckedAt < 1000) return;
  state.__labelCheckedAt = now;
  let stamp = 0;
  try {
    stamp = statSync(journal).mtimeMs;
  } catch {
    return;
  }
  if (state.__labelMigrated === stamp) return;
  migrate(conn, { migrationsFolder });
  state.__labelMigrated = stamp;
}

ensureMigrated();

/** The database. Every use first makes sure the schema is up to date. */
export const db: DB = new Proxy(conn, {
  get(target, prop, receiver) {
    ensureMigrated();
    const value = Reflect.get(target, prop, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

export { schema };
