import "server-only";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, schema } from "@/db";

/*
 * Single-use links to join a label-made band account (see schema.bandInviteLinks). Whoever opens
 * one signs in, or signs up with any email, and becomes one of the band's logins: the band's own
 * shared login, or, with a member named on the link, that member's own.
 */

export const INVITE_LINK_DAYS = 14;

/** "2026-09-27 14:03:00" in UTC, like the rest of the app's timestamps. */
export const stamp = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

export type OpenInviteLink = { id: string; personId: number | null; personName: string | null; expiresAt: string };

/** A band account's links that can still be used, newest first, with the member each is for. */
export async function openInviteLinks(bandOrgId: string): Promise<OpenInviteLink[]> {
  const rows = await db
    .select({ link: schema.bandInviteLinks, personName: schema.people.name })
    .from(schema.bandInviteLinks)
    .leftJoin(schema.people, eq(schema.people.id, schema.bandInviteLinks.personId))
    .where(
      and(
        eq(schema.bandInviteLinks.orgId, bandOrgId),
        isNull(schema.bandInviteLinks.usedAt),
        isNull(schema.bandInviteLinks.canceledAt),
        gt(schema.bandInviteLinks.expiresAt, stamp(new Date())),
      ),
    );
  return rows
    .map((r) => ({ id: r.link.id, personId: r.link.personId, personName: r.personName, expiresAt: r.link.expiresAt }))
    .sort((a, b) => b.expiresAt.localeCompare(a.expiresAt));
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
    .select({ name: schema.organization.name })
    .from(schema.accountLinks)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.accountLinks.labelOrgId))
    .where(and(eq(schema.accountLinks.bandOrgId, row.org.id), eq(schema.accountLinks.managed, true)));
  return { link: row.link, band: row.org, personName: row.personName, labelName: label?.name ?? null };
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
