import { getCloudflareContext } from "@opennextjs/cloudflare";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { openLocal } from "@/db/local";
import * as schema from "./schema";

/*
 * The database. On Cloudflare: Postgres (Neon) through Hyperdrive, with a fresh connection for each
 * request (Workers can't share one between requests). Everywhere else (`npm run dev`, scripts):
 * Postgres from DATABASE_URL, one pool per process. Tests: an in-memory Postgres (local-pglite.ts).
 */

export type DB = NodePgDatabase<typeof schema>;

/** Running on Cloudflare Workers (not Node). */
export const onCloudflare = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === "Cloudflare-Workers";

// Off Cloudflare: one connection per server process (survives dev hot reloads).
const state = globalThis as unknown as { __labelDb?: ReturnType<typeof openLocal>; __labelReady?: Promise<void> };
const local = () => (state.__labelDb ??= openLocal());

// On Cloudflare: one database client per request, kept for the rest of that request.
const perRequest = new WeakMap<object, DB>();
function forThisRequest(): DB {
  const { env, ctx } = getCloudflareContext();
  let db = perRequest.get(ctx);
  if (!db) {
    const hyperdrive = (env as unknown as { HYPERDRIVE: { connectionString: string } }).HYPERDRIVE;
    // A few connections for this request only (Hyperdrive does the real pooling); never reused by another request.
    db = drizzle(new Pool({ connectionString: hyperdrive.connectionString, max: 5, idleTimeoutMillis: 2_000 }), { schema });
    perRequest.set(ctx, db);
  }
  return db;
}

const current = (): DB => (onCloudflare ? forThisRequest() : local().db);

/** The database, used as before (`db.select()…`): it picks the right connection each time it's used. */
export const db: DB = new Proxy({} as DB, {
  get(_target, prop) {
    const real = current();
    const value = Reflect.get(real, prop, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
});

/**
 * Resolves once the schema is up to date. Locally the server runs migrations at startup
 * (src/instrumentation.ts); scripts and tests await it. On Cloudflare migrations run before each
 * deploy (`npm run db:migrate`), so there's nothing to wait for.
 */
export const ready: PromiseLike<void> = {
  // Lazy: started the first time something waits for it, never just by loading this module (as
  // `next build` does).
  then: (resolve, reject) => (onCloudflare ? Promise.resolve() : (state.__labelReady ??= local().migrate())).then(resolve, reject),
};

export { schema };
