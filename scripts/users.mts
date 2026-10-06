/*
 * `npm run users`: everyone who has signed up, with the accounts they belong to and their role.
 * Reads the local database `npm run dev` starts (so the app must be running), unless DATABASE_URL says otherwise.
 */
import pg from "pg";

const client = new pg.Client(process.env.DATABASE_URL ?? "postgres://postgres:local@127.0.0.1:5433/label_payouts");
await client.connect().catch(() => {
  console.error("Couldn't reach the database. Is the app running (npm run dev)?");
  process.exit(1);
});
const { rows } = await client.query(`
  select u.name, u.email, u.email_verified, u.created_at,
         coalesce(string_agg(o.name || ' (' || o.kind || ', ' || m.role || ')', '; ' order by o.name), '') as accounts
  from "user" u
  left join member m on m.user_id = u.id
  left join organization o on o.id = m.organization_id
  group by u.id order by u.created_at`);
await client.end();
console.table(
  rows.map((r) => ({
    name: r.name,
    email: r.email,
    verified: r.email_verified ? "yes" : "no",
    joined: new Date(r.created_at).toISOString().slice(0, 10),
    accounts: r.accounts || "(none)",
  })),
);
console.log(`${rows.length} user(s).`);
