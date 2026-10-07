/*
 * `npm run db:migrate`: bring a database's schema up to date (drizzle/ migrations). For the live
 * site, run against Neon's direct connection string before each deploy (npm run deploy does it).
 * Uses DATABASE_URL.
 */
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL to the database to migrate.");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url, max: 1 });
await migrate(drizzle(pool), { migrationsFolder: join(process.cwd(), "drizzle") });
await pool.end();
console.log(`Schema up to date on ${new URL(url).host}.`);
