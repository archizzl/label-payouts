import { join } from "node:path";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as schema from "./schema";

/*
 * The database outside Cloudflare: Postgres from DATABASE_URL (the local one `npm run dev` starts,
 * or the hosted one, for scripts like db:migrate). Tests swap this module for local-pglite.ts.
 */
export function openLocal(): { db: NodePgDatabase<typeof schema>; migrate: () => Promise<void> } {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL isn't set. Start the app with `npm run dev`, which runs a local database, or set DATABASE_URL.");
  const db = drizzle(new Pool({ connectionString: url }), { schema });
  return { db, migrate: () => migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") }) };
}
