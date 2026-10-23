/*
 * `npm run workers:local`: the app as it runs on Cloudflare (the built Worker, in wrangler's local
 * runtime), on http://localhost:8799, against a throwaway database. For checking a change in the
 * real runtime before deploying, without touching your local data or the live site.
 *
 *   --port 8800    another port
 *   --no-build     reuse the last build (.open-next) instead of building again
 *   --fresh        start the throwaway database over, empty
 *
 * The database lives in .workers-local/ (git-ignored) and is kept between runs. Sign up at /signup
 * as admin@example.test (a site admin here) to create accounts. Ctrl-C stops everything and removes
 * the temporary files it made (.dev.vars and wrangler.local.tmp.jsonc). OPENROUTER_API_KEY,
 * DEEPSEEK_API_KEY or GEMINI_API_KEY in the shell turns Abel on here.
 */
import { execSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { envWithNode22 } from "./node22.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const port = Number(args[args.indexOf("--port") + 1]) || 8799;
const DIR = ".workers-local";
const CONFIG = "wrangler.local.tmp.jsonc";
const VARS = ".dev.vars";
const MARK = "# Written by npm run workers:local; removed when it stops.";

if (existsSync(VARS) && !readFileSync(VARS, "utf8").startsWith(MARK)) {
  console.error(`${VARS} already exists and isn't this script's. Move it aside first.`);
  process.exit(1);
}
if (flag("--fresh")) rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

// A database of its own (own folder and port), so your local data stays untouched.
process.env.LOCAL_PG_DIR = `${DIR}/pg`;
process.env.LOCAL_PG_PORT ??= "5449";
const { startLocalDatabase } = await import("./local-db.mjs");
const db = await startLocalDatabase({ quiet: true });
execSync("npx tsx scripts/migrate.mts", { stdio: "inherit", env: { ...process.env, DATABASE_URL: db.url } });

// Test secrets, and the live config without its routes (with routes, wrangler pretends every
// request is for labelmaker.ing, and sign-ins fail as coming from the wrong address).
const secret = () => randomBytes(32).toString("hex");
// Abel's key, if the shell has one (OPENROUTER_API_KEY=…, DEEPSEEK_API_KEY=… or GEMINI_API_KEY=… npm run workers:local).
const passThrough = ["GEMINI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "ABEL_PROVIDER", "ABEL_MODEL"].filter((k) => process.env[k]).map((k) => `${k}=${process.env[k]}`);
writeFileSync(
  VARS,
  [MARK, `BETTER_AUTH_SECRET=${secret()}`, `APP_ENCRYPTION_KEY=${secret()}`, `CRON_SECRET=${secret()}`, `CATALOG_SYNC_SECRET=${secret()}`, `BETTER_AUTH_URL=http://localhost:${port}`, "SITE_ADMIN_EMAILS=admin@example.test", "BANDCAMP_API=off", ...passThrough, ""].join("\n"),
);
writeFileSync(CONFIG, readFileSync("wrangler.jsonc", "utf8").replace(/\n\s*"routes": \[[\s\S]*?\],/, ""));

const cleanUp = async () => {
  rmSync(CONFIG, { force: true });
  if (existsSync(VARS) && readFileSync(VARS, "utf8").startsWith(MARK)) rmSync(VARS);
  await db.stop();
};

const env = envWithNode22({ CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: db.url });
try {
  if (!flag("--no-build")) execSync("npx opennextjs-cloudflare build", { stdio: "inherit", env });
} catch {
  await cleanUp();
  process.exit(1);
}

const vars = [`BETTER_AUTH_URL:http://localhost:${port}`, "SITE_ADMIN_EMAILS:admin@example.test", "ADMIN_URL:", "COOKIE_DOMAIN:"].flatMap((v) => ["--var", v]);
const wrangler = spawn("npx", ["wrangler", "dev", "-c", CONFIG, "--port", String(port), ...vars], { stdio: "inherit", env });
let stopping = false;
const stop = async (code) => {
  if (stopping) return;
  stopping = true;
  wrangler.kill("SIGTERM");
  await cleanUp();
  process.exit(code);
};
wrangler.on("exit", (code) => stop(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => stop(0));
