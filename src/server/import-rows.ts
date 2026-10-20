import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";

/** An account's import of this name (the one hand-added sales hang off, say), made the first time it's needed. */
export async function importNamed(orgId: string, filename: string) {
  const [found] = await db
    .select({ id: schema.imports.id })
    .from(schema.imports)
    .where(and(eq(schema.imports.orgId, orgId), eq(schema.imports.filename, filename)));
  if (found) return found.id;
  const [made] = await db.insert(schema.imports).values({ orgId, filename, rowCount: 0, addedCount: 0, duplicateCount: 0 }).returning({ id: schema.imports.id });
  return made.id;
}
