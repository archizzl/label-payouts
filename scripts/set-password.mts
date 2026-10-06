/*
 * `npm run set-password -- someone@example.com`: give a login a new password (e.g. one you've
 * forgotten). It asks for the new password without showing it, so it never lands in your shell
 * history, and signs that login out everywhere. Uses the local database `npm run dev` starts (so the
 * app must be running), unless DATABASE_URL says otherwise.
 */
import { hashPassword } from "better-auth/crypto";
import pg from "pg";

/** Read a line from the terminal without echoing it. (Piped input works too, a line per answer.) */
let pending = "";
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    let value = "";
    const take = (chunk: string) => {
      for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i];
        if (ch === "\r" || ch === "\n") {
          pending = chunk.slice(i + (ch === "\r" && chunk[i + 1] === "\n" ? 2 : 1));
          return true;
        }
        if (ch === "\u0003") process.exit(130); // ctrl-c
        if (ch === "\u007f") value = value.slice(0, -1); // backspace
        else value += ch;
      }
      return false;
    };
    const finish = () => {
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
      resolve(value);
    };
    const onData = (chunk: string) => {
      if (take(chunk)) finish();
    };
    const left = pending;
    pending = "";
    if (take(left)) {
      process.stdout.write("\n");
      return resolve(value);
    }
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.resume();
  });
}

const email = (process.argv[2] ?? "").trim().toLowerCase();
if (!email) {
  console.error("Usage: npm run set-password -- someone@example.com");
  process.exit(1);
}

const client = new pg.Client(process.env.DATABASE_URL ?? "postgres://postgres:local@127.0.0.1:5433/label_payouts");
await client.connect().catch(() => {
  console.error("Couldn't reach the database. Is the app running (npm run dev)?");
  process.exit(1);
});

const { rows } = await client.query(`select id, name from "user" where lower(email) = $1`, [email]);
if (!rows.length) {
  console.error(`No login with the email ${email}. (npm run users lists them.)`);
  await client.end();
  process.exit(1);
}
const user = rows[0];

const password = await askHidden(`New password for ${user.name} (${email}): `);
if (password.length < 8) {
  console.error("Use at least 8 characters. Nothing changed.");
  await client.end();
  process.exit(1);
}
if ((await askHidden("Type it again: ")) !== password) {
  console.error("Those don't match. Nothing changed.");
  await client.end();
  process.exit(1);
}

const hash = await hashPassword(password);
const updated = await client.query(`update account set password = $1, updated_at = now() where user_id = $2 and provider_id = 'credential'`, [
  hash,
  user.id,
]);
if (!updated.rowCount) {
  await client.query(
    `insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at)
     values (gen_random_uuid()::text, $1, 'credential', $1, $2, now(), now())`,
    [user.id, hash],
  );
}
// Sign them out everywhere, so only the new password works from here on.
const signedOut = await client.query(`delete from session where user_id = $1`, [user.id]);
await client.end();
console.log(`Done. ${user.name} can sign in with the new password (signed out of ${signedOut.rowCount} session(s)).`);
