/*
 * `npm run sync-catalog [-- --account "Reaction Future Records"] [-- --local]`
 *
 * Reads your public Bandcamp pages from this Mac and updates the LIVE catalog: new releases and
 * merch, track lists, artwork, release dates, artists. The live site can't do this itself: Bandcamp
 * shows cloud servers a bot check instead of its pages. `npm run sync-catalog:schedule` runs it every
 * 10 minutes while this Mac is on.
 *
 * It never uses the Bandcamp API, so it can't disturb the live site's sign-in. The live database
 * is PRODUCTION_DATABASE_URL, from the shell or .deploy.local. With --local it updates the local
 * database instead (DATABASE_URL, or the one `npm run dev` runs).
 */
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { configuredDatabaseUrl, startLocalDatabase } from "./local-db.mjs";

const { values: args } = parseArgs({ options: { account: { type: "string" }, local: { type: "boolean" } } });

process.env.BANDCAMP_API = "off";
let stopDb = async () => {};
if (args.local) {
  if (!configuredDatabaseUrl()) {
    const local = await startLocalDatabase({ quiet: true });
    process.env.DATABASE_URL = local.url;
    stopDb = local.stop;
  }
} else {
  let url = process.env.PRODUCTION_DATABASE_URL;
  if (!url && existsSync(".deploy.local")) url = readFileSync(".deploy.local", "utf8").match(/^PRODUCTION_DATABASE_URL=(.+)$/m)?.[1]?.trim();
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
const accounts = (
  await db
    .select({ orgId: schema.accountSettings.orgId, url: schema.accountSettings.bandcampUrl, name: schema.organization.name })
    .from(schema.accountSettings)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.accountSettings.orgId))
    .where(isNotNull(schema.accountSettings.bandcampUrl))
).filter((a) => !args.account || a.name === args.account);

if (!accounts.length) console.log(args.account ? `No account called “${args.account}” with a Bandcamp address.` : "No accounts have a Bandcamp address.");
for (const a of accounts) {
  const r = await syncCatalog(a.orgId);
  console.log(`${new Date().toISOString()}  ${a.name} → ${where}: ${r.summary}`);
  for (const e of r.errors) console.log(`  ! ${e}`);
}
await stopDb();
process.exit(0);
