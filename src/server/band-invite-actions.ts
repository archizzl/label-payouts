"use server";

import { randomUUID } from "node:crypto";
import { and, eq, isNull, ne } from "drizzle-orm";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import { subAccountFor } from "./band-accounts";
import { hasSharedLogin, resetStandingLink, stamp, unclaimedMembers, usableInviteLink } from "./band-invite-links";
import { auth } from "./auth";
import { getSession, requireAdmin } from "./context";

export type InviteLinkState = { ok?: string; error?: string; url?: string } | null;

/**
 * The band account an invite link is for, checked: the band account itself (its own Settings), or a
 * label admin making one for one of its bands (`bandId`).
 */
async function bandAccountFor(fd: FormData) {
  const ctx = await requireAdmin();
  if (ctx.managedBy) return { bandOrgId: ctx.orgId, labelOrgId: ctx.managedBy.labelOrgId, bandId: ctx.managedBy.bandId, userId: ctx.user.id, label: false };
  const sub = await subAccountFor(ctx.orgId, Number(fd.get("bandId")));
  if (!sub) throw new Error("This band doesn’t have an account from the label.");
  return { bandOrgId: sub.org.id, labelOrgId: ctx.orgId, bandId: sub.link.labelBandId, userId: ctx.user.id, label: true };
}

function refresh(bandId: number) {
  revalidatePath("/account");
  revalidatePath("/directory");
  revalidatePath(`/bands/${bandId}`);
}

/** Reset the band's standing invite link: the old one stops working. */
export async function resetInviteLink(fd: FormData) {
  const a = await bandAccountFor(fd);
  await resetStandingLink(a.bandOrgId, a.userId);
  refresh(a.bandId);
}

/** Use an invite link: the signed-in login joins the band's account, then works in it. */
export async function joinWithInviteLink(_: InviteLinkState, fd: FormData): Promise<InviteLinkState> {
  const id = String(fd.get("id") ?? "");
  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(`/join/${id}`)}`);
  const found = await usableInviteLink(id);
  if (!found) return { error: "This invite link has been used, cancelled or has expired. Ask for a new one." };
  const { link, band, labelOrgId, bandId } = found;
  const userId = session.user.id;
  const now = stamp(new Date());
  // Who they are: the member the link names, one they picked (who has no login of their own yet),
  // someone new to add to the band, or the band itself (its shared login).
  const choice = link.personId ? String(link.personId) : String(fd.get("as") ?? "");
  const newName = String(fd.get("name") ?? "").trim().slice(0, 120);
  let personId: number | null = null;
  if (choice === "new") {
    if (!newName) return { error: "Enter your name." };
  } else if (choice === "band") {
    // One shared login per band.
    if (await hasSharedLogin(band.id)) return { error: `${band.name} already has its shared login. Choose who you are.` };
  } else {
    personId = Number(choice) || null;
    // Each member has at most one login of their own.
    const open = await unclaimedMembers(band.id, labelOrgId, bandId);
    if (!personId || !open.some((p) => p.id === personId)) return { error: "That member already has a login. Choose who you are." };
  }
  // A link from before standing links was single-use: mark it used. The standing link stays open.
  if (link.expiresAt < "9999") {
    const claimed = await db
      .update(schema.bandInviteLinks)
      .set({ usedAt: now, usedByUserId: userId })
      .where(and(eq(schema.bandInviteLinks.id, id), isNull(schema.bandInviteLinks.usedAt), isNull(schema.bandInviteLinks.canceledAt)))
      .returning({ id: schema.bandInviteLinks.id });
    if (!claimed.length) return { error: "This invite link was just used." };
  }
  const [already] = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, band.id), eq(schema.member.userId, userId)));
  if (!already) {
    // The band's own login manages the account; a member's own login just uses it.
    await db.insert(schema.member).values({ id: randomUUID(), organizationId: band.id, userId, role: choice === "band" ? "admin" : "member", createdAt: new Date() });
  }
  if (choice === "new") {
    // Someone not in the label's books yet: a new member of the band.
    const [p] = await db.insert(schema.people).values({ orgId: labelOrgId, name: newName }).returning({ id: schema.people.id });
    await db.insert(schema.bandMemberships).values({ orgId: labelOrgId, bandId, personId: p.id, roles: [], active: true });
    personId = p.id;
  }
  if (personId) {
    try {
      await db
        .insert(schema.bandLoginPeople)
        .values({ orgId: band.id, userId, personId })
        .onConflictDoUpdate({ target: [schema.bandLoginPeople.orgId, schema.bandLoginPeople.userId], set: { personId } });
    } catch {
      // Someone else just took that member (one login per member).
      return { error: "That member already has a login. Choose who you are." };
    }
  }
  // Straight into the band's account (through Better Auth, so the cached session cookie follows).
  await auth.api.setActiveOrganization({ body: { organizationId: band.id }, headers: await headers() });
  revalidatePath("/", "layout");
  redirect("/");
}

/**
 * Who one of a band account's logins signs in as: the band itself (its one shared login), or one
 * member (who has no other login there). A login that becomes the band's, and belongs to nothing
 * else, takes the band's name.
 */
export async function setLoginIdentity(_: InviteLinkState, fd: FormData): Promise<InviteLinkState> {
  let a;
  try {
    a = await bandAccountFor(fd);
  } catch (e) {
    return { error: (e as Error).message };
  }
  const userId = String(fd.get("userId") ?? "");
  const as = String(fd.get("as") ?? "");
  // The band's own login changing itself would leave nobody (but the label) to manage logins.
  if (userId === a.userId && !a.label) return { error: "Change your own login from the label’s side." };
  const [login] = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, a.bandOrgId), eq(schema.member.userId, userId)));
  if (!login) return { error: "That login isn’t one of the band’s." };
  if (as === "band") {
    // One shared login per band: another login already being the band blocks it.
    const [personal, logins] = await Promise.all([
      db.select({ userId: schema.bandLoginPeople.userId }).from(schema.bandLoginPeople).where(eq(schema.bandLoginPeople.orgId, a.bandOrgId)),
      db.select({ userId: schema.member.userId }).from(schema.member).where(eq(schema.member.organizationId, a.bandOrgId)),
    ]);
    if (logins.some((l) => l.userId !== userId && !personal.some((p) => p.userId === l.userId))) {
      return { error: "Another login already signs in as the band. Change that one first." };
    }
    await db.delete(schema.bandLoginPeople).where(and(eq(schema.bandLoginPeople.orgId, a.bandOrgId), eq(schema.bandLoginPeople.userId, userId)));
    const elsewhere = await db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(and(eq(schema.member.userId, userId), ne(schema.member.organizationId, a.bandOrgId)));
    if (!elsewhere.length) {
      const [band] = await db.select({ name: schema.organization.name }).from(schema.organization).where(eq(schema.organization.id, a.bandOrgId));
      if (band) await db.update(schema.user).set({ name: band.name }).where(eq(schema.user.id, userId));
    }
    // The band's login manages the account's logins.
    await db.update(schema.member).set({ role: "admin" }).where(eq(schema.member.id, login.id));
  } else {
    const personId = Number(as);
    const [mine] = await db
      .select({ personId: schema.bandLoginPeople.personId })
      .from(schema.bandLoginPeople)
      .where(and(eq(schema.bandLoginPeople.orgId, a.bandOrgId), eq(schema.bandLoginPeople.userId, userId)));
    const open = await unclaimedMembers(a.bandOrgId, a.labelOrgId, a.bandId);
    if (mine?.personId !== personId && !open.some((p) => p.id === personId)) return { error: "That member already has a login." };
    await db
      .insert(schema.bandLoginPeople)
      .values({ orgId: a.bandOrgId, userId, personId })
      .onConflictDoUpdate({ target: [schema.bandLoginPeople.orgId, schema.bandLoginPeople.userId], set: { personId } });
    // A member's own login sees the band, not who can sign in to it.
    await db.update(schema.member).set({ role: "member" }).where(eq(schema.member.id, login.id));
  }
  refresh(a.bandId);
  revalidatePath("/", "layout");
  return { ok: "Saved." };
}
