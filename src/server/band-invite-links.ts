import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { bandMembers } from "./band-member";

/*
 * Invite links to join a label-made band account (see schema.bandInviteLinks). Each band has one
 * standing link: whoever opens it signs in, or signs up with any email, and becomes one of the
 * band's logins (a member's own, or the band's shared one), until the link is reset. Older links
 * were single-use: once used (usedAt), they stay dead.
 */

/** "2026-09-27 14:03:00" in UTC, like the rest of the app's timestamps. */
export const stamp = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

/** A standing link never runs out (until it's reset). */
const NEVER = "9999-12-31 00:00:00";

/**
 * A band account's standing invite link, the same every time: whoever has it can join, until the
 * link is reset. Made the first time it's needed (the newest open link, if there are older ones).
 */
export async function standingInviteLink(bandOrgId: string, createdByUserId: string | null): Promise<string> {
  const [open] = await db
    .select({ id: schema.bandInviteLinks.id })
    .from(schema.bandInviteLinks)
    .where(
      and(
        eq(schema.bandInviteLinks.orgId, bandOrgId),
        isNull(schema.bandInviteLinks.usedAt),
        isNull(schema.bandInviteLinks.canceledAt),
        gt(schema.bandInviteLinks.expiresAt, stamp(new Date())),
      ),
    )
    .orderBy(desc(schema.bandInviteLinks.createdAt))
    .limit(1);
  if (open) return open.id;
  const id = randomUUID();
  await db.insert(schema.bandInviteLinks).values({ id, orgId: bandOrgId, createdByUserId, expiresAt: NEVER });
  return id;
}

/** Reset: every open link to the band's account stops working, and a new standing one replaces them. */
export async function resetStandingLink(bandOrgId: string, createdByUserId: string | null) {
  await db
    .update(schema.bandInviteLinks)
    .set({ canceledAt: stamp(new Date()) })
    .where(and(eq(schema.bandInviteLinks.orgId, bandOrgId), isNull(schema.bandInviteLinks.usedAt), isNull(schema.bandInviteLinks.canceledAt)));
  return standingInviteLink(bandOrgId, createdByUserId);
}

/** A link that can still be used, with its band account and label, or null. */
export async function usableInviteLink(id: string) {
  const [row] = await db
    .select({ link: schema.bandInviteLinks, org: schema.organization, personName: schema.people.name })
    .from(schema.bandInviteLinks)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.bandInviteLinks.orgId))
    .leftJoin(schema.people, eq(schema.people.id, schema.bandInviteLinks.personId))
    .where(eq(schema.bandInviteLinks.id, id));
  if (!row || row.link.usedAt || row.link.canceledAt || row.link.expiresAt <= stamp(new Date())) return null;
  const [label] = await db
    .select({ name: schema.organization.name, labelOrgId: schema.accountLinks.labelOrgId, bandId: schema.accountLinks.labelBandId })
    .from(schema.accountLinks)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.accountLinks.labelOrgId))
    .where(and(eq(schema.accountLinks.bandOrgId, row.org.id), eq(schema.accountLinks.managed, true)));
  if (!label) return null;
  return { link: row.link, band: row.org, personName: row.personName, labelName: label.name, labelOrgId: label.labelOrgId, bandId: label.bandId };
}

/** The band's members in the label's books who don't have a login of their own on its account yet. */
export async function unclaimedMembers(bandOrgId: string, labelOrgId: string, bandId: number) {
  const [members, claimed] = await Promise.all([
    bandMembers(labelOrgId, bandId),
    db.select({ personId: schema.bandLoginPeople.personId }).from(schema.bandLoginPeople).where(eq(schema.bandLoginPeople.orgId, bandOrgId)),
  ]);
  return members.filter((m) => !claimed.some((c) => c.personId === m.id));
}

/** Whether a band account already has its shared login (a login that isn't one member's own). */
export async function hasSharedLogin(bandOrgId: string) {
  const [logins, personal] = await Promise.all([
    db.select({ userId: schema.member.userId }).from(schema.member).where(eq(schema.member.organizationId, bandOrgId)),
    db.select({ userId: schema.bandLoginPeople.userId }).from(schema.bandLoginPeople).where(eq(schema.bandLoginPeople.orgId, bandOrgId)),
  ]);
  return logins.some((l) => !personal.some((p) => p.userId === l.userId));
}

/** The member each of a band account's personal logins is, by user id. */
export async function bandLoginNames(bandOrgId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ userId: schema.bandLoginPeople.userId, name: schema.people.name })
    .from(schema.bandLoginPeople)
    .innerJoin(schema.people, eq(schema.people.id, schema.bandLoginPeople.personId))
    .where(eq(schema.bandLoginPeople.orgId, bandOrgId));
  return new Map(rows.map((r) => [r.userId, r.name]));
}
