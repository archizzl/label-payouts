/*
 * Wrangler (Cloudflare's tool) needs Node 22 or newer, but the tests need the Node that
 * better-sqlite3 was built for (the default, 20). Scripts that run wrangler call this to get an
 * environment whose PATH puts Node 22 first: the current Node if it's new enough, else the newest
 * Node 22+ installed with nvm. So `npm run deploy` works whichever Node the shell has.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const major = (v) => Number(String(v).replace(/^v/, "").split(".")[0]);

/** The Node 22+ to run: this one if it's new enough, else the newest installed with nvm (null: none). */
export function node22Path() {
  if (major(process.versions.node) >= 22) return process.execPath;
  const root = join(process.env.NVM_DIR ?? join(homedir(), ".nvm"), "versions", "node");
  const found = existsSync(root)
    ? readdirSync(root)
        .filter((v) => major(v) >= 22)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]
    : undefined;
  return found ? join(root, found, "bin", "node") : null;
}

export function envWithNode22(extra = {}) {
  const env = { ...process.env, ...extra };
  const node = node22Path();
  if (!node) {
    console.error(`Wrangler needs Node 22 or newer (this is ${process.version}). Install it with: nvm install 22`);
    process.exit(1);
  }
  if (node !== process.execPath) env.PATH = `${dirname(node)}${delimiter}${env.PATH ?? ""}`;
  return env;
}
