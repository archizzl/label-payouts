/*
 * `npm run sync-catalog [-- --account "Reaction Future Records"] [-- --local]`
 *
 * Reads your public Bandcamp pages from this Mac and updates the LIVE catalog: new releases and
 * merch, track lists, artwork, release dates, artists and their photos. The live site can't do this
 * itself: Bandcamp shows cloud servers a bot check instead of its pages.
 *
 * `npm run sync-catalog:schedule` runs it on its own: launchd starts it every minute with
 * --if-due, and it only does anything when 10 minutes have passed since the last run or someone
 * pressed "Sync now" on the live site (a request it checks with the site, not the database, so
 * quiet minutes never wake the database).
 *
 * It never uses the Bandcamp API, so it can't disturb the live site's sign-in. The live database
 * is PRODUCTION_DATABASE_URL, from the shell or .deploy.local. With --local it updates the local
 * database instead (DATABASE_URL, or the one `npm run dev` runs).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { configuredDatabaseUrl, startLocalDatabase } from "./local-db.mjs";

const { values: args } = parseArgs({
  options: { account: { type: "string" }, local: { type: "boolean" }, "if-due": { type: "boolean" } },
});

/** How often the scheduled run syncs without being asked. Keep in step with CATALOG_SYNC_EVERY_MINUTES. */
const EVERY_MS = 10 * 60 * 1000;
const STATE = "data/catalog-sync.json";

const deployLocal = existsSync(".deploy.local") ? readFileSync(".deploy.local", "utf8") : "";
const setting = (name: string) => process.env[name] ?? deployLocal.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim();
const site = (setting("LIVE_SITE_URL") ?? "https://labelmaker.ing").replace(/\/$/, "");
const secret = setting("CATALOG_SYNC_SECRET");
const startedAt = new Date().toISOString();
const stamp = () => new Date().toISOString();

// "Sync now" requests waiting on the live site.
async function requests(): Promise<{ orgId: string; at: string }[]> {
  if (args.local || !secret) return [];
  try {
    const res = await fetch(`${site}/api/catalog-sync`, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`the site answered ${res.status}`);
    return ((await res.json()) as { requests: { orgId: string; at: string }[] }).requests;
  } catch (e) {
    if (!args["if-due"]) console.log(`  (couldn't check for "Sync now" requests: ${(e as Error).message})`);
    return [];
  }
}
async function clearRequest(orgId: string) {
  await fetch(`${site}/api/catalog-sync`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ orgId, before: startedAt }),
    signal: AbortSignal.timeout(15000),
  }).catch(() => {});
}

const waiting = await requests();
const lastRun = existsSync(STATE) ? (JSON.parse(readFileSync(STATE, "utf8")) as { lastRun?: string }).lastRun : undefined;
const due = !args["if-due"] || !lastRun || Date.parse(lastRun) < Date.now() - EVERY_MS;
// Nothing to do this minute: stop before touching the database.
if (!due && !waiting.length) process.exit(0);

process.env.BANDCAMP_API = "off";
let stopDb = async () => {};
if (args.local) {
  if (!configuredDatabaseUrl()) {
    const local = await startLocalDatabase({ quiet: true });
    process.env.DATABASE_URL = local.url;
    stopDb = local.stop;
  }
} else {
  const url = setting("PRODUCTION_DATABASE_URL");
  if (!url) {
    console.error("Put PRODUCTION_DATABASE_URL (Neon's direct connection string) in .deploy.local, or use --local.");
    process.exit(1);
  }
  process.env.DATABASE_URL = url;
}

// After the settings above: the app's modules read them when they load.
const { db, ready, schema } = await import("../src/db");
// The local database is brought up to date here; the live one is by `npm run deploy`.
if (args.local) await ready;
const { syncCatalog } = await import("../src/server/auto-sync");
const { eq, isNotNull } = await import("drizzle-orm");

const where = args.local ? "the local database" : new URL(process.env.DATABASE_URL!).host;
const requested = new Set(waiting.map((r) => r.orgId));
const accounts = (
  await db
    .select({ orgId: schema.accountSettings.orgId, name: schema.organization.name })
    .from(schema.accountSettings)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.accountSettings.orgId))
    .where(isNotNull(schema.accountSettings.bandcampUrl))
)
  .filter((a) => !args.account || a.name === args.account)
  // On schedule: everyone when it's time, otherwise just the accounts that asked.
  .filter((a) => due || requested.has(a.orgId));

if (!accounts.length && !args["if-due"]) {
  console.log(args.account ? `No account called “${args.account}” with a Bandcamp address.` : "No accounts have a Bandcamp address.");
}
for (const a of accounts) {
  const r = await syncCatalog(a.orgId);
  console.log(`${stamp()}  ${a.name} → ${where}${requested.has(a.orgId) ? " (Sync now)" : ""}: ${r.summary}`);
  for (const e of r.errors) console.log(`  ! ${e}`);
  if (requested.has(a.orgId)) await clearRequest(a.orgId);
}
if (due && !args.account) {
  mkdirSync("data", { recursive: true });
  writeFileSync(STATE, JSON.stringify({ lastRun: startedAt }));
}
await stopDb();
process.exit(0);
