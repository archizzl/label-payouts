/*
 * `npm run sync-catalog [-- --account "Reaction Future Records"] [-- --local]`
 *
 * Reads your public Bandcamp pages from this Mac and updates the LIVE catalog: new releases and
 * merch, track lists, artwork, release dates, artists and their photos. The live site can't do this
 * itself: Bandcamp shows cloud servers a bot check instead of its pages.
 *
 * `npm run sync-catalog:schedule` runs it on its own (scripts/catalog-watcher.mjs, kept running by
 * launchd): every minute with --if-due, when it only does anything if 10 minutes have passed since
 * the last run or someone pressed "Sync now" on the live site (a request it checks with the site,
 * not the database, so quiet minutes never wake the database); and straight away when the site
 * sends a Sync now down the watcher's connection, with --request '{"orgId":…,"bandIds":…}'.
 *
 * It never uses the Bandcamp API, so it can't disturb the live site's sign-in. The live database
 * is PRODUCTION_DATABASE_URL, from the shell or .deploy.local. With --local it updates the local
 * database instead (DATABASE_URL, or the one `npm run dev` runs).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { configuredDatabaseUrl, startLocalDatabase } from "./local-db.mjs";

const { values: args } = parseArgs({
  options: { account: { type: "string" }, local: { type: "boolean" }, "if-due": { type: "boolean" }, request: { type: "string", multiple: true } },
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

// A run stuck on a stalled connection (after the Mac sleeps mid-sync, say) would stop every later
// one: launchd doesn't start another while it's still going. So a run gives up after 15 minutes.
setTimeout(() => {
  console.log(`${stamp()}  Gave up: still going after 15 minutes. The next run starts within a minute.`);
  process.exit(1);
}, 15 * 60 * 1000);

// "Sync now" requests waiting on the live site (for all of an account, or some of its bands).
type Request = { orgId: string; at: string; bandIds?: number[] | null };
async function requests(): Promise<Request[]> {
  if (args.local || !secret) return [];
  try {
    const res = await fetch(`${site}/api/catalog-sync`, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`the site answered ${res.status}`);
    return ((await res.json()) as { requests: Request[] }).requests;
  } catch (e) {
    if (!args["if-due"]) console.log(`  (couldn't check for "Sync now" requests: ${(e as Error).message})`);
    return [];
  }
}
// How far a sync has got, for the page to show (at most every couple of seconds).
let lastReport = 0;
function reportProgress(orgId: string, done: number, total: number) {
  if (args.local || !secret || (done < total && Date.now() - lastReport < 2000)) return;
  lastReport = Date.now();
  void fetch(`${site}/api/catalog-sync`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ orgId, progress: { done, total } }),
    signal: AbortSignal.timeout(15000),
  }).catch(() => {});
}
async function clearRequest(orgId: string) {
  await fetch(`${site}/api/catalog-sync`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ orgId, before: startedAt }),
    signal: AbortSignal.timeout(15000),
  }).catch(() => {});
}

// Requests the watcher was sent directly (they may not be in the site's list yet), with the site's.
const given = (args.request ?? []).flatMap((r): Request[] => {
  try {
    const x = JSON.parse(r) as Partial<Request>;
    return typeof x.orgId === "string" ? [{ orgId: x.orgId, at: x.at ?? startedAt, bandIds: x.bandIds ?? null }] : [];
  } catch {
    return [];
  }
});
const waiting: Request[] = [];
for (const r of [...given, ...(await requests())]) {
  const same = waiting.find((w) => w.orgId === r.orgId);
  if (!same) waiting.push(r);
  // Some bands and some others: those bands; anything for all of it: all of it.
  else same.bandIds = same.bandIds && r.bandIds ? [...new Set([...same.bandIds, ...r.bandIds])] : null;
}
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
// Asked for some bands only (a band's own group pressing "Sync now"): just their releases, unless
// it's time for everyone's anyway.
const onlyBandsOf = (orgId: string) => {
  if (due) return null;
  const r = waiting.find((x) => x.orgId === orgId);
  return r?.bandIds?.length ? r.bandIds : null;
};
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
  const onlyBands = onlyBandsOf(a.orgId);
  const r = await syncCatalog(a.orgId, { onlyBands, onProgress: (done, total) => reportProgress(a.orgId, done, total) });
  const why = requested.has(a.orgId) ? (onlyBands ? ` (Sync now, ${onlyBands.length === 1 ? "one band" : `${onlyBands.length} bands`})` : " (Sync now)") : "";
  console.log(`${stamp()}  ${a.name} → ${where}${why}: ${r.summary}`);
  for (const e of r.errors) console.log(`  ! ${e}`);
  if (requested.has(a.orgId)) await clearRequest(a.orgId);
}
if (due && !args.account) {
  mkdirSync("data", { recursive: true });
  writeFileSync(STATE, JSON.stringify({ lastRun: startedAt }));
}
await stopDb();
process.exit(0);
