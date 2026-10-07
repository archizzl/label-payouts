/*
 * `npm run deploy`: migrate the live database, build for Cloudflare, and deploy.
 *
 * The live database's direct connection string comes from PRODUCTION_DATABASE_URL, in the shell or
 * in .deploy.local (not committed). Not a .env file: the Cloudflare build bakes .env, .env.production,
 * .env.local and .env.production.local into the live app, so the deploy refuses if any of them exist.
 * Your local settings live in .env.development.local, which the build skips. See DEPLOY.md.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

for (const f of [".env", ".env.local", ".env.production", ".env.production.local"]) {
  if (existsSync(f)) {
    console.error(`Found ${f}: the Cloudflare build would bake it into the live app. Keep local settings in .env.development.local, and live ones in Cloudflare secrets.`);
    process.exit(1);
  }
}
let url = process.env.PRODUCTION_DATABASE_URL;
if (!url && existsSync(".deploy.local")) {
  url = readFileSync(".deploy.local", "utf8").match(/^PRODUCTION_DATABASE_URL=(.+)$/m)?.[1]?.trim();
}
if (!url) {
  console.error("Set PRODUCTION_DATABASE_URL (Neon's direct connection string) in .deploy.local. See DEPLOY.md.");
  process.exit(1);
}
const run = (cmd, env = {}) => execSync(cmd, { stdio: "inherit", env: { ...process.env, ...env } });
run("npx tsx scripts/migrate.mts", { DATABASE_URL: url });
run("npx opennextjs-cloudflare build");
run("npx opennextjs-cloudflare deploy");
