import "server-only";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import { accountsFor } from "./context";
import { discardStoredFiles } from "./receipt-store";

/**
 * Delete accounts and everything in them: their books, people, receipts and the receipts' files,
 * and the band accounts they made for their bands. Logins aren't deleted, only taken out of them.
 */
export async function deleteAccountsWithBooks(ids: string[]) {
  if (!ids.length) return;
  // The band accounts they made go with them (they only show their books).
  const made = (
    await db
      .select({ orgId: schema.accountLinks.bandOrgId })
      .from(schema.accountLinks)
      .where(and(inArray(schema.accountLinks.labelOrgId, ids), eq(schema.accountLinks.managed, true)))
  )
    .map((r) => r.orgId)
    .filter((id): id is string => !!id);
  const orgIds = [...ids, ...made];
  const files = await db
    .select({ storageKey: schema.expenseFiles.storageKey })
    .from(schema.expenseFiles)
    .innerJoin(schema.expenses, eq(schema.expenses.id, schema.expenseFiles.expenseId))
    .where(inArray(schema.expenses.orgId, orgIds));
  const photos = await db.select({ storageKey: schema.merchPhotos.storageKey }).from(schema.merchPhotos).where(inArray(schema.merchPhotos.orgId, orgIds));
  // Everything in an account goes with it (every table's account reference cascades).
  await db.delete(schema.organization).where(inArray(schema.organization.id, orgIds));
  await discardStoredFiles([...files, ...photos]);
}

/**
 * The accounts only this login runs: a label, or a band that runs its own account, with no other
 * owner or admin. Deleting the login deletes these too (a band account a label made is the label's).
 */
export async function soleAccounts(userId: string): Promise<{ id: string; name: string }[]> {
  const accounts = (await accountsFor(userId)).filter((a) => a.role !== "member");
  if (!accounts.length) return [];
  const ids = accounts.map((a) => a.id);
  const [managed, otherAdmins] = await Promise.all([
    db
      .select({ orgId: schema.accountLinks.bandOrgId })
      .from(schema.accountLinks)
      .where(and(inArray(schema.accountLinks.bandOrgId, ids), eq(schema.accountLinks.managed, true), eq(schema.accountLinks.status, "active"))),
    db
      .select({ orgId: schema.member.organizationId })
      .from(schema.member)
      .where(and(inArray(schema.member.organizationId, ids), ne(schema.member.userId, userId), inArray(schema.member.role, ["owner", "admin"]))),
  ]);
  return accounts
    .filter((a) => !managed.some((m) => m.orgId === a.id) && !otherAdmins.some((o) => o.orgId === a.id))
    .map((a) => ({ id: a.id, name: a.name }));
}
