/*
 * `npm run copy-to-production -- [--account "Reaction Future Records"] [--go]`
 *
 * Copies one label/band account from the local database (DATABASE_URL, from .env.development.local)
 * to the live one (PRODUCTION_DATABASE_URL, from the shell or .deploy.local): the account, its
 * members' logins (with their passwords, so they can sign in as before), and everything in its books.
 * Sessions aren't copied (everyone signs in again), nor are other accounts or their logins.
 *
 * Without --go it only reports what it would copy. The live database must already be migrated
 * (npm run db:migrate) and must not already have this account.
 */
import { existsSync, readFileSync } from "node:fs";
import pg from "pg";

const args = process.argv.slice(2);
const accountName = args.includes("--account") ? args[args.indexOf("--account") + 1] : "Reaction Future Records";
const go = args.includes("--go");

// The local database `npm run dev` runs, unless DATABASE_URL says otherwise.
const sourceUrl = process.env.DATABASE_URL ?? `postgres://postgres:local@127.0.0.1:${process.env.LOCAL_PG_PORT ?? 5433}/label_payouts`;
let targetUrl = process.env.PRODUCTION_DATABASE_URL;
if (!targetUrl && existsSync(".deploy.local")) targetUrl = readFileSync(".deploy.local", "utf8").match(/^PRODUCTION_DATABASE_URL=(.+)$/m)?.[1]?.trim();
if (!sourceUrl || !targetUrl) {
  console.error("Needs DATABASE_URL (the local database) and PRODUCTION_DATABASE_URL (Neon's direct connection string, in .deploy.local).");
  process.exit(1);
}
if (sourceUrl === targetUrl) {
  console.error("The local and live databases are the same; nothing to copy.");
  process.exit(1);
}

const source = new pg.Client({ connectionString: sourceUrl });
const target = new pg.Client({ connectionString: targetUrl });
await source.connect();
await target.connect();

// Never copied: logins' sessions, one-off tokens, rate-limit counters, migration bookkeeping, signup invites.
const SKIP = new Set(["session", "verification", "rate_limit", "signup_invites", "__drizzle_migrations"]);

const [org] = (await source.query(`select * from organization where name = $1`, [accountName])).rows;
if (!org) {
  console.error(`No account called “${accountName}” in the local database.`);
  process.exit(1);
}
if ((await target.query(`select 1 from organization where id = $1 or name = $2`, [org.id, accountName])).rowCount) {
  console.error(`The live database already has “${accountName}”. Nothing copied.`);
  process.exit(1);
}

// Every table, its columns (and which are json), and its foreign keys.
const tables = (await source.query(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`)).rows
  .map((r) => r.table_name as string)
  .filter((t) => !SKIP.has(t));
const columns = new Map<string, { name: string; json: boolean }[]>();
for (const t of tables) {
  const cols = await source.query(`select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`, [t]);
  columns.set(t, cols.rows.map((c) => ({ name: c.column_name, json: c.data_type === "json" || c.data_type === "jsonb" })));
}
const fks = (
  await source.query(`
    select tc.table_name as t, kcu.column_name as c, ccu.table_name as rt, ccu.column_name as rc
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
    join information_schema.constraint_column_usage ccu on tc.constraint_name = ccu.constraint_name and tc.table_schema = ccu.table_schema
    where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'`)
).rows as { t: string; c: string; rt: string; rc: string }[];

// Copy order: a table after every table it points to.
const order: string[] = [];
const visit = (t: string, path: Set<string>) => {
  if (order.includes(t) || path.has(t) || !tables.includes(t)) return;
  path.add(t);
  for (const f of fks.filter((f) => f.t === t && f.rt !== t)) visit(f.rt, path);
  order.push(t);
};
for (const t of tables) visit(t, new Set());

// Which rows belong to the account.
const memberIds = (await source.query(`select user_id from member where organization_id = $1`, [org.id])).rows.map((r) => r.user_id as string);
const rowsFor = async (t: string): Promise<Record<string, unknown>[]> => {
  const names = columns.get(t)!.map((c) => c.name);
  if (t === "organization") return (await source.query(`select * from organization where id = $1`, [org.id])).rows;
  if (t === "user") return (await source.query(`select * from "user" where id = any($1)`, [memberIds])).rows;
  if (t === "account") return (await source.query(`select * from account where user_id = any($1)`, [memberIds])).rows;
  if (names.includes("organization_id")) return (await source.query(`select * from "${t}" where organization_id = $1`, [org.id])).rows;
  if (names.includes("org_id")) return (await source.query(`select * from "${t}" where org_id = $1`, [org.id])).rows;
  return []; // decided below from what it points to (e.g. fan_bands)
};

const copied = new Map<string, Record<string, unknown>[]>();
const report: string[] = [];
for (const t of order) {
  let rows = await rowsFor(t);
  const own = fks.filter((f) => f.t === t);
  if (!rows.length && !columns.get(t)!.some((c) => ["org_id", "organization_id"].includes(c.name)) && !["organization", "user", "account"].includes(t)) {
    // A table without an account column (like fan_bands): its rows whose parents are being copied.
    const parent = own.find((f) => copied.has(f.rt));
    if (parent) {
      const keys = copied.get(parent.rt)!.map((r) => r[parent.rc]);
      rows = keys.length ? (await source.query(`select * from "${t}" where "${parent.c}" = any($1)`, [keys])).rows : [];
    }
  }
  // Drop rows pointing at something that isn't coming along (e.g. another account); clear optional links instead.
  let dropped = 0;
  for (const f of own) {
    if (!copied.has(f.rt) || f.rt === t) continue;
    const present = new Set(copied.get(f.rt)!.map((r) => String(r[f.rc])));
    rows = rows.filter((r) => {
      const v = r[f.c];
      if (v === null || v === undefined || present.has(String(v))) return true;
      dropped++;
      return false;
    });
  }
  copied.set(t, rows);
  if (rows.length || dropped) report.push(`${t.padEnd(22)} ${String(rows.length).padStart(6)}${dropped ? `   (${dropped} left behind: they point at other accounts)` : ""}`);
}

console.log(`${go ? "Copying" : "Would copy"} “${accountName}” to ${new URL(targetUrl).host}:\n`);
console.log(report.join("\n"));
if (!go) {
  console.log("\nNothing copied yet. Run again with --go to copy.");
  await source.end();
  await target.end();
  process.exit(0);
}

await target.query("begin");
try {
  for (const t of order) {
    const rows = copied.get(t)!;
    if (!rows.length) continue;
    const cols = columns.get(t)!;
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const values: unknown[] = [];
      const tuples = chunk.map((r) => `(${cols.map((c) => {
        const v = r[c.name];
        values.push(c.json && v !== null && v !== undefined ? JSON.stringify(v) : v);
        return `$${values.length}`;
      }).join(", ")})`);
      await target.query(`insert into "${t}" (${cols.map((c) => `"${c.name}"`).join(", ")}) values ${tuples.join(", ")}`, values);
    }
    // Keep generated ids going from where the copied ones end.
    const seq = cols.some((c) => c.name === "id") ? (await target.query(`select pg_get_serial_sequence($1, 'id') as s`, [`public."${t}"`])).rows[0]?.s : null;
    if (seq) await target.query(`select setval($1, greatest((select coalesce(max(id), 0) from "${t}"), 1))`, [seq]);
  }
  await target.query("commit");
  console.log("\nDone. Everyone in the account can sign in on the live site with their usual email and password.");
} catch (e) {
  await target.query("rollback");
  console.error("\nCopy failed; nothing was changed on the live database:", (e as Error).message);
  process.exitCode = 1;
}
await source.end();
await target.end();
