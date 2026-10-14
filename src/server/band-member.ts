import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { cache } from "react";
import { db, schema } from "@/db";
import { accountContext, BAND_MEMBER_COOKIE, bandLoginPerson } from "./context";

/*
 * A band account the label made has one login for the whole band. Whoever's using it picks which
 * member they are (any of them, and they can switch to any other): that member's earnings are the
 * ones shown. The choice is a cookie, "<band account id>|<person id>", checked against the band's
 * current members in the label's books on every request. Until someone picks, it's the account's
 * default member, if it has one.
 */

export { BAND_MEMBER_COOKIE };

export type BandMember = { id: number; name: string };

/** The band's current members in the label's books. */
export async function bandMembers(labelOrgId: string, bandId: number): Promise<BandMember[]> {
  return db
    .select({ id: schema.people.id, name: schema.people.name })
    .from(schema.bandMemberships)
    .innerJoin(schema.people, eq(schema.people.id, schema.bandMemberships.personId))
    .where(
      and(eq(schema.bandMemberships.orgId, labelOrgId), eq(schema.bandMemberships.bandId, bandId), eq(schema.bandMemberships.active, true)),
    )
    .orderBy(asc(schema.people.name));
}

/**
 * In a label-made band account: its members, and which of them is using it (null: the whole band).
 * `fixed`: the login is that member's own, so there's nothing to pick.
 */
export const bandMemberChoice = cache(async (): Promise<{ members: BandMember[]; chosen: BandMember | null; fixed: boolean } | null> => {
  const ctx = await accountContext();
  if (!ctx.managedBy) return null;
  const [members, who] = await Promise.all([bandMembers(ctx.managedBy.labelOrgId, ctx.managedBy.bandId), bandLoginPerson(ctx)]);
  return { members, chosen: members.find((m) => m.id === who.personId) ?? null, fixed: who.fixed };
});
