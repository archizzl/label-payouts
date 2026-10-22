/*
 * `npm run dev`: start the local Postgres (unless DATABASE_URL points elsewhere), then Next's dev
 * server. Extra arguments go to Next, e.g. `npm run dev -- -p 3002`.
 *
 * New migrations (a schema change, or a pull) are applied as they land in drizzle/, not just when
 * the server starts, so a running app never queries a column its database doesn't have yet.
 */
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { configuredDatabaseUrl, startLocalDatabase } from "./local-db.mjs";

let stop = async () => {};
if (!configuredDatabaseUrl()) {
  const local = await startLocalDatabase({ quiet: true });
  process.env.DATABASE_URL = local.url;
  stop = local.stop;
  console.log(`Local database running (${process.env.LOCAL_PG_DIR ?? "data/postgres"}).`);
}

const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
// drizzle-kit writes the migration's SQL, then its entry in meta/_journal.json: wait for both.
let timer = null;
let migrating = false;
let again = false;
const migrate = () => {
  if (migrating) return void (again = true);
  migrating = true;
  const run = spawn("npx", ["tsx", "scripts/migrate.mts"], { stdio: "inherit", env: process.env });
  run.on("exit", () => {
    migrating = false;
    if (again) {
      again = false;
      migrate();
    }
  });
};
const watcher = watch("drizzle/meta", (_, file) => {
  if (file !== "_journal.json") return;
  clearTimeout(timer);
  timer = setTimeout(migrate, 500);
});

let exiting = false;
const shutdown = async (code) => {
  if (exiting) return;
  exiting = true;
  watcher.close();
  next.kill("SIGTERM");
  await stop();
  process.exit(code);
};
next.on("exit", (code) => shutdown(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => shutdown(0));
