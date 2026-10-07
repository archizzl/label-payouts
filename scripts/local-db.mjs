/*
 * The local development database: a real Postgres (from the embedded-postgres package, no install
 * needed) with its data in data/postgres. Used by `npm run dev` and the scripts when DATABASE_URL
 * isn't set. It's safe with several processes at once and survives crashes, unlike an in-process
 * database.
 */
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const DB_NAME = "label_payouts";

/** DATABASE_URL from the environment or .env.development.local, if set. */
export function configuredDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const file = join(process.cwd(), ".env.development.local");
  if (!existsSync(file)) return null;
  const line = readFileSync(file, "utf8")
    .split("\n")
    .find((l) => /^\s*DATABASE_URL\s*=/.test(l));
  return line ? line.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "") : null;
}

const listening = (port) =>
  new Promise((resolve) => {
    const s = createConnection({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.end(), resolve(true)));
    s.once("error", () => resolve(false));
  });

/**
 * Start the local Postgres (creating it the first time) unless it's already running, and return
 * its URL and a function that stops it again if we started it.
 */
export async function startLocalDatabase({ quiet = false } = {}) {
  const port = Number(process.env.LOCAL_PG_PORT ?? 5433);
  const url = `postgres://postgres:local@127.0.0.1:${port}/${DB_NAME}`;
  if (await listening(port)) return { url, stop: async () => {} }; // e.g. another `npm run dev`

  const dir = process.env.LOCAL_PG_DIR ?? join(process.cwd(), "data", "postgres");
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: "postgres",
    password: "local",
    port,
    persistent: true,
    onLog: quiet ? () => {} : undefined,
    onError: (e) => console.error(String(e)),
  });
  if (!existsSync(join(dir, "PG_VERSION"))) {
    console.log(`Creating the local database in ${dir}…`);
    await pg.initialise();
  }
  await pg.start();
  const client = pg.getPgClient("postgres", "127.0.0.1");
  await client.connect();
  const { rowCount } = await client.query("select 1 from pg_database where datname = $1", [DB_NAME]);
  if (!rowCount) await client.query(`create database ${DB_NAME}`);
  await client.end();
  return { url, stop: () => pg.stop() };
}
