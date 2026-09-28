/*
 * Move the books from the old local app into a label account, owned by an existing login.
 *
 *   1. Create your login at /signup (don't create an account there).
 *   2. Stop the dev server (the local database can only be open in one place), then run:
 *        npm run import:local -- --email you@example.com --sqlite ../label-payouts/data/label.db
 *      Optional: --name "Label name" (defaults to the label band's name) --kind band
 *
 * Also copies BANDCAMP_CLIENT_ID / BANDCAMP_CLIENT_SECRET from the environment, if set, into the
 * account's settings (encrypted).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { and, eq } from "drizzle-orm";
import { db, ready, schema } from "../src/db";
import { importLocalBooks } from "../src/server/import-local";
import { normalizeEmail } from "../src/server/people";
import { encryptSecret } from "../src/server/secrets";

const { values: args } = parseArgs({
  options: { email: { type: "string" }, sqlite: { type: "string" }, name: { type: "string" }, kind: { type: "string", default: "label" } },
});
if (!args.email || !args.sqlite) {
  console.error("Usage: npm run import:local -- --email you@example.com --sqlite path/to/label.db [--name 'Label name']");
  process.exit(1);
}

await ready;
const [user] = await db.select().from(schema.user).where(eq(schema.user.email, normalizeEmail(args.email)));
if (!user) {
  console.error(`No login for ${args.email}. Create one at /signup first.`);
  process.exit(1);
}

const orgId = randomUUID();
const kind = args.kind === "band" ? "band" : "label";
await db.insert(schema.organization).values({ id: orgId, name: args.name ?? "Imported label", slug: `imported-${randomBytes(3).toString("hex")}`, createdAt: new Date(), kind });
await db.insert(schema.member).values({ id: randomUUID(), organizationId: orgId, userId: user.id, role: "owner", createdAt: new Date() });

const counts = await importLocalBooks(resolve(args.sqlite), orgId);

// Name the account after the label's own band, unless a name was given.
if (!args.name) {
  const [labelBand] = await db.select().from(schema.bands).where(and(eq(schema.bands.orgId, orgId), eq(schema.bands.isLabel, true)));
  if (labelBand) await db.update(schema.organization).set({ name: labelBand.name }).where(eq(schema.organization.id, orgId));
}

// Link the login to their payee record (same email).
const mine = (await db.select().from(schema.people).where(eq(schema.people.orgId, orgId))).find(
  (p) => normalizeEmail(p.email) === normalizeEmail(user.email),
);
if (mine) await db.update(schema.people).set({ userId: user.id }).where(eq(schema.people.id, mine.id));

if (process.env.BANDCAMP_CLIENT_ID && process.env.BANDCAMP_CLIENT_SECRET) {
  await db.insert(schema.accountSettings).values({
    orgId,
    bandcampClientId: process.env.BANDCAMP_CLIENT_ID,
    bandcampClientSecret: encryptSecret(process.env.BANDCAMP_CLIENT_SECRET),
  });
}

const [org] = await db.select().from(schema.organization).where(eq(schema.organization.id, orgId));
console.log(`Imported into "${org.name}" (${kind}), owned by ${user.email}:`);
for (const [table, n] of Object.entries(counts)) console.log(`  ${table}: ${n}`);
console.log(mine ? `Linked your login to ${mine.name}.` : "No person with your email; link yourself on the My earnings page.");
console.log(process.env.BANDCAMP_CLIENT_ID ? "Copied the Bandcamp API access into the account settings." : "");
process.exit(0);
