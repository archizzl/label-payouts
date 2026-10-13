import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { bandcampSubdomain } from "@/lib/applications";
import { slugify } from "@/lib/slug";
import { auth } from "./auth";

/*
 * Applications for new label and band accounts (src/lib/applications.ts). Anyone can create a login
 * and apply; a site admin approves or rejects from the admin dashboard. Approving sets the account
 * up from the application. People who signed up with an admin's invite link skip this.
 */

const { accountApplications, signupInvites } = schema;

/** Someone's latest application, if any. */
export async function latestApplication(userId: string) {
  const [row] = await db.select().from(accountApplications).where(eq(accountApplications.userId, userId)).orderBy(desc(accountApplications.id)).limit(1);
  return row ?? null;
}

/** Signed up with an admin's invite link: may create an account without applying. */
export async function preapproved(userId: string) {
  const [row] = await db.select({ id: signupInvites.id }).from(signupInvites).where(eq(signupInvites.usedByUserId, userId)).limit(1);
  return !!row;
}

export const listApplications = () => db.select({ app: accountApplications, user: schema.user }).from(accountApplications).innerJoin(schema.user, eq(schema.user.id, accountApplications.userId)).orderBy(desc(accountApplications.createdAt));

const INVITE_DAYS = 14;

/**
 * Approve: make the account (the applicant owns it), with its Bandcamp address, and what they
 * listed: a band with its members (invites for those with an email), or a label's artists as bands
 * (and invites for its team). Returns the new account's id.
 */
export async function approveApplication(id: number, reviewerId: string): Promise<string> {
  const [app] = await db.select().from(accountApplications).where(and(eq(accountApplications.id, id), eq(accountApplications.status, "pending")));
  if (!app) throw new Error("That application isn't waiting any more.");
  const [applicant] = await db.select().from(schema.user).where(eq(schema.user.id, app.userId));
  if (!applicant) throw new Error("The applicant's login is gone.");

  // As the system, on their behalf: they become its owner.
  const org = await auth.api.createOrganization({ body: { name: app.name, slug: slugify(app.name), kind: app.kind, userId: app.userId } });
  if (!org) throw new Error("Couldn't create the account.");
  const orgId = org.id;
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000);
  const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

  await db.transaction(async (tx) => {
    await tx.insert(schema.accountSettings).values({ orgId, bandcampUrl: app.bandcampUrl }).onConflictDoUpdate({ target: schema.accountSettings.orgId, set: { bandcampUrl: app.bandcampUrl } });
    const [me] = await tx.insert(schema.people).values({ orgId, userId: app.userId, name: applicant.name, email: applicant.email }).returning();
    const invite = (email: string, personId: number | null, role: "member" | "admin" = "member") =>
      tx.insert(schema.invitation).values({ id: randomUUID(), organizationId: orgId, email, role, status: "pending", expiresAt, inviterId: app.userId, personId });

    if (app.kind === "band") {
      const sub = bandcampSubdomain(app.bandcampUrl);
      const [band] = await tx.insert(schema.bands).values({ orgId, name: app.name, urlPatterns: sub ? [sub] : [] }).returning();
      const mine = app.members.find((m) => same(m.email, applicant.email) || same(m.name, applicant.name));
      await tx.insert(schema.bandMemberships).values({ orgId, bandId: band.id, personId: me.id, roles: mine?.role ? [mine.role] : [] });
      for (const m of app.members) {
        if (m === mine) continue;
        const [p] = await tx.insert(schema.people).values({ orgId, name: m.name, email: m.email }).returning();
        await tx.insert(schema.bandMemberships).values({ orgId, bandId: band.id, personId: p.id, roles: m.role ? [m.role] : [] });
        if (m.email) await invite(m.email, p.id);
      }
    } else {
      for (const a of app.artists) {
        const sub = bandcampSubdomain(a.bandcampUrl);
        await tx.insert(schema.bands).values({ orgId, name: a.name, urlPatterns: sub ? [sub] : [] });
      }
      for (const t of app.team) {
        if (same(t.email, applicant.email)) continue;
        const [p] = await tx.insert(schema.people).values({ orgId, name: t.name, email: t.email }).returning();
        await invite(t.email, p.id);
      }
    }
    await tx
      .update(accountApplications)
      .set({ status: "approved", orgId, reviewedAt: new Date().toISOString(), reviewedByUserId: reviewerId })
      .where(eq(accountApplications.id, app.id));
  });
  return orgId;
}

export async function rejectApplication(id: number, reviewerId: string, note: string | null) {
  await db
    .update(accountApplications)
    .set({ status: "rejected", reviewNote: note, reviewedAt: new Date().toISOString(), reviewedByUserId: reviewerId })
    .where(and(eq(accountApplications.id, id), eq(accountApplications.status, "pending")));
}
