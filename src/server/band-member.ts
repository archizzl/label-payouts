import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { cache } from "react";
import { db, schema } from "@/db";
import { getContext } from "./context";

/*
 * A band account the label made has one login for the whole band. Whoever's using it picks which
 * member they are (any of them, and they can switch to any other): that member's earnings are the
 * ones shown. The choice is a cookie, "<band account id>|<person id>", checked against the band's
 * current members in the label's books on every request. Until someone picks, it's the account's
 * default member, if it has one.
 */

export const BAND_MEMBER_COOKIE = "lm_band_member";

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

/** In a label-made band account: its members, and which of them is using it (null until picked). */
export const bandMemberChoice = cache(async (): Promise<{ members: BandMember[]; chosen: BandMember | null } | null> => {
  const ctx = await getContext();
  if (!ctx.managedBy) return null;
  const members = await bandMembers(ctx.managedBy.labelOrgId, ctx.managedBy.bandId);
  const [orgId, id] = ((await cookies()).get(BAND_MEMBER_COOKIE)?.value ?? "").split("|");
  const picked = orgId === ctx.orgId ? members.find((m) => m.id === Number(id)) : undefined;
  const chosen = picked ?? members.find((m) => m.id === ctx.managedBy!.defaultPersonId) ?? null;
  return { members, chosen };
});
