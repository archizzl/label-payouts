/*
 * Move the books from the old local app into a label account, owned by an existing login.
 *
 *   1. Create your login at /signup.
 *   2. Run (the dev server can keep running):
 *        npm run import:local -- --email you@example.com --sqlite ../label-payouts/data/label.db
 *      That creates a new account. Optional: --name "Label name" (defaults to the label band's
 *      name) --kind band
 *
 *   Or fill an account you've already created (and are an owner or admin of):
 *        npm run import:local -- --email you@example.com --sqlite … --account "Reaction Future Records"
 *      If it already has books, add --replace to swap them for the old app's. That keeps the account,
 *      who can sign in (and their payee records), settings, invites and links.
 *
 * Also copies BANDCAMP_CLIENT_ID / BANDCAMP_CLIENT_SECRET from the environment, if set, into the
 * account's settings (encrypted), unless the account already has its own.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { and, eq, isNull } from "drizzle-orm";
import { configuredDatabaseUrl, startLocalDatabase } from "./local-db.mjs";

// The local database (started if needed), unless DATABASE_URL points elsewhere. This must happen
// before the app's database module loads.
let stopDb = async () => {};
if (!configuredDatabaseUrl()) {
  const local = await startLocalDatabase({ quiet: true });
  process.env.DATABASE_URL = local.url;
  stopDb = local.stop;
}
const { db, ready, schema } = await import("../src/db");
const { accountHasBooks, clearBooks, importLocalBooks } = await import("../src/server/import-local");
const { mergePeople, normalizeEmail } = await import("../src/server/people");
const { encryptSecret } = await import("../src/server/secrets");

const fail = async (message: string) => {
  console.error(message);
  await stopDb();
  process.exit(1);
};

const { values: args } = parseArgs({
  options: {
    email: { type: "string" },
    sqlite: { type: "string" },
    name: { type: "string" },
    kind: { type: "string", default: "label" },
    account: { type: "string" },
    replace: { type: "boolean", default: false },
  },
});
if (!args.email || !args.sqlite) {
  await fail("Usage: npm run import:local -- --email you@example.com --sqlite path/to/label.db [--account 'Name' [--replace]] [--name 'Label name']");
}

await ready;
const [user] = await db.select().from(schema.user).where(eq(schema.user.email, normalizeEmail(args.email!)));
if (!user) await fail(`No login for ${args.email}. Create one at /signup first.`);

let orgId: string;
if (args.account) {
  // An account they already belong to, as owner or admin, by name or id.
  const mine = await db
    .select({ org: schema.organization, role: schema.member.role })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
    .where(eq(schema.member.userId, user.id));
  const matches = mine.filter(({ org }) => org.id === args.account || org.name.toLowerCase() === args.account!.toLowerCase());
  if (matches.length !== 1) await fail(`You have ${matches.length === 0 ? "no" : "more than one"} account called "${args.account}". Use its exact name or id.`);
  const [{ org, role }] = matches;
  if (role === "member") await fail(`You're only a member of "${org.name}"; an owner or admin has to import.`);
  orgId = org.id;
  if (await accountHasBooks(orgId)) {
    if (!args.replace) await fail(`"${org.name}" already has books. Add --replace to swap them for the old app's (logins, settings and invites are kept).`);
    await clearBooks(orgId);
    console.log(`Cleared the old books from "${org.name}".`);
  }
} else {
  orgId = randomUUID();
  const kind = args.kind === "band" ? "band" : "label";
  await db
    .insert(schema.organization)
    .values({ id: orgId, name: args.name ?? "Imported label", slug: `imported-${randomBytes(3).toString("hex")}`, createdAt: new Date(), kind });
  await db.insert(schema.member).values({ id: randomUUID(), organizationId: orgId, userId: user.id, role: "owner", createdAt: new Date() });
}

const counts = await importLocalBooks(resolve(args.sqlite!), orgId);

// A new account is named after the label's own band, unless a name was given.
if (!args.account && !args.name) {
  const [labelBand] = await db.select().from(schema.bands).where(and(eq(schema.bands.orgId, orgId), eq(schema.bands.isLabel, true)));
  if (labelBand) await db.update(schema.organization).set({ name: labelBand.name }).where(eq(schema.organization.id, orgId));
}

// Everyone who can sign in to this account: link each login to the imported person with their
// email, merging if they already had a payee record here.
const logins = await db
  .select({ userId: schema.user.id, email: schema.user.email })
  .from(schema.member)
  .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
  .where(eq(schema.member.organizationId, orgId));
const linked: string[] = [];
for (const login of logins) {
  const people = await db.select().from(schema.people).where(eq(schema.people.orgId, orgId));
  const imported = people.find((p) => !p.userId && normalizeEmail(p.email) === normalizeEmail(login.email));
  if (!imported) continue;
  const existing = people.find((p) => p.userId === login.userId);
  if (existing) await mergePeople(orgId, existing.id, imported.id);
  else await db.update(schema.people).set({ userId: login.userId }).where(and(eq(schema.people.id, imported.id), isNull(schema.people.userId)));
  linked.push(`${login.email} → ${imported.name}`);
}

const [settings] = await db.select().from(schema.accountSettings).where(eq(schema.accountSettings.orgId, orgId));
let copiedApi = false;
if (!settings?.bandcampClientId && process.env.BANDCAMP_CLIENT_ID && process.env.BANDCAMP_CLIENT_SECRET) {
  const values = { bandcampClientId: process.env.BANDCAMP_CLIENT_ID, bandcampClientSecret: encryptSecret(process.env.BANDCAMP_CLIENT_SECRET) };
  await db
    .insert(schema.accountSettings)
    .values({ orgId, ...values })
    .onConflictDoUpdate({ target: schema.accountSettings.orgId, set: values });
  copiedApi = true;
}

const [org] = await db.select().from(schema.organization).where(eq(schema.organization.id, orgId));
console.log(`Imported into "${org.name}" (${org.kind}):`);
for (const [table, n] of Object.entries(counts)) console.log(`  ${table}: ${n}`);
console.log(linked.length ? `Linked logins: ${linked.join("; ")}.` : "No login matched an imported person's email; link yourself on the My earnings page.");
if (copiedApi) console.log("Copied the Bandcamp API access into the account settings.");
await stopDb();
process.exit(0);
