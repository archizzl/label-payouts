import { randomUUID } from "node:crypto";

// A fresh in-memory Postgres for each test file. Must be set before the db module loads, which is
// why tests import it dynamically, after this module.
process.env.PGLITE_DIR = "memory://";

export async function testDb() {
  const mod = await import("@/db");
  await mod.ready;
  return mod;
}

/** A new label (or band) account to put test data in; returns its orgId. */
export async function newAccount(name = "Test Label", kind: "label" | "band" = "label") {
  const { db, schema } = await testDb();
  const id = randomUUID();
  await db.insert(schema.organization).values({ id, name, slug: id, createdAt: new Date(), kind });
  return id;
}
