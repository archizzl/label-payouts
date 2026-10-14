/*
 * Wrangler (Cloudflare's tool) needs Node 22 or newer, but the tests need the Node that
 * better-sqlite3 was built for (the default, 20). Scripts that run wrangler call this to get an
 * environment whose PATH puts Node 22 first: the current Node if it's new enough, else the newest
 * Node 22+ installed with nvm. So `npm run deploy` works whichever Node the shell has.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const major = (v) => Number(String(v).replace(/^v/, "").split(".")[0]);

export function envWithNode22(extra = {}) {
  const env = { ...process.env, ...extra };
  if (major(process.versions.node) >= 22) return env;
  const root = join(process.env.NVM_DIR ?? join(homedir(), ".nvm"), "versions", "node");
  const found = existsSync(root)
    ? readdirSync(root)
        .filter((v) => major(v) >= 22)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]
    : undefined;
  if (!found) {
    console.error(`Wrangler needs Node 22 or newer (this is ${process.version}). Install it with: nvm install 22`);
    process.exit(1);
  }
  env.PATH = `${join(root, found, "bin")}${delimiter}${env.PATH ?? ""}`;
  return env;
}
