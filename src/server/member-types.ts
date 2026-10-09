import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";

/*
 * Member types (src/lib/permissions.ts): the account's list, and who has which. A role choice in
 * Settings is "admin", "member" (just their own earnings) or "type:<id>" (a member with that type).
 */

const { memberTypes, memberTypeAssignments, invitationMemberTypes } = schema;

export type RoleChoice = { role: "admin" | "member"; memberTypeId: number | null };

/** Read a role choice from a form, checking the member type belongs to this account. */
export async function parseRoleChoice(orgId: string, value: string): Promise<RoleChoice> {
  if (value === "admin") return { role: "admin", memberTypeId: null };
  const id = value.startsWith("type:") ? Number(value.slice(5)) : NaN;
  if (!Number.isInteger(id)) return { role: "member", memberTypeId: null };
  const [t] = await db.select({ id: memberTypes.id }).from(memberTypes).where(and(eq(memberTypes.orgId, orgId), eq(memberTypes.id, id)));
  if (!t) throw new Error("That member type doesn't exist any more.");
  return { role: "member", memberTypeId: t.id };
}

export const listMemberTypes = (orgId: string) => db.select().from(memberTypes).where(eq(memberTypes.orgId, orgId)).orderBy(memberTypes.name);

/** Each login's member type in this account: userId → member type id. */
export async function memberTypeOf(orgId: string): Promise<Map<string, number>> {
  const rows = await db.select().from(memberTypeAssignments).where(eq(memberTypeAssignments.orgId, orgId));
  return new Map(rows.map((r) => [r.userId, r.memberTypeId]));
}

/** Give a login a member type here, or none. */
export async function assignMemberType(orgId: string, userId: string, memberTypeId: number | null) {
  await db.delete(memberTypeAssignments).where(and(eq(memberTypeAssignments.orgId, orgId), eq(memberTypeAssignments.userId, userId)));
  if (memberTypeId !== null) await db.insert(memberTypeAssignments).values({ orgId, userId, memberTypeId });
}

/** Invites: the member type each one gives, invitation id → member type id. */
export async function inviteMemberTypes(invitationIds: string[]): Promise<Map<string, number>> {
  if (!invitationIds.length) return new Map();
  const rows = await db.select().from(invitationMemberTypes);
  return new Map(rows.filter((r) => invitationIds.includes(r.invitationId)).map((r) => [r.invitationId, r.memberTypeId]));
}

export async function setInviteMemberType(invitationId: string, memberTypeId: number) {
  await db.insert(invitationMemberTypes).values({ invitationId, memberTypeId }).onConflictDoUpdate({ target: invitationMemberTypes.invitationId, set: { memberTypeId } });
}

/** When an invite is accepted: the member type it gives, if any (and only for this account's types). */
export async function memberTypeForInvite(orgId: string, invitationId: string): Promise<number | null> {
  const [row] = await db
    .select({ id: memberTypes.id })
    .from(invitationMemberTypes)
    .innerJoin(memberTypes, eq(memberTypes.id, invitationMemberTypes.memberTypeId))
    .where(and(eq(invitationMemberTypes.invitationId, invitationId), eq(memberTypes.orgId, orgId)));
  return row?.id ?? null;
}
