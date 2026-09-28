/*
 * `npm run dev`: start the local Postgres (unless DATABASE_URL points elsewhere), then Next's dev
 * server. Extra arguments go to Next, e.g. `npm run dev -- -p 3002`.
 */
import { spawn } from "node:child_process";
import { configuredDatabaseUrl, startLocalDatabase } from "./local-db.mjs";

let stop = async () => {};
if (!configuredDatabaseUrl()) {
  const local = await startLocalDatabase({ quiet: true });
  process.env.DATABASE_URL = local.url;
  stop = local.stop;
  console.log(`Local database running (${process.env.LOCAL_PG_DIR ?? "data/postgres"}).`);
}

const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
let exiting = false;
const shutdown = async (code) => {
  if (exiting) return;
  exiting = true;
  next.kill("SIGTERM");
  await stop();
  process.exit(code);
};
next.on("exit", (code) => shutdown(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => shutdown(0));
