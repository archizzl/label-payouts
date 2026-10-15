"use server";

import { randomUUID } from "node:crypto";
import { and, eq, isNull, ne } from "drizzle-orm";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import { subAccountFor } from "./band-accounts";
import { hasSharedLogin, INVITE_LINK_DAYS, stamp, unclaimedMembers, usableInviteLink } from "./band-invite-links";
import { auth } from "./auth";
import { getSession, requireAdmin } from "./context";

export type InviteLinkState = { ok?: string; error?: string; url?: string } | null;

/**
 * The band account an invite link is for, checked: the band account itself (its own Settings), or a
 * label admin making one for one of its bands (`bandId`).
 */
async function bandAccountFor(fd: FormData) {
  const ctx = await requireAdmin();
  if (ctx.managedBy) return { bandOrgId: ctx.orgId, labelOrgId: ctx.managedBy.labelOrgId, bandId: ctx.managedBy.bandId, userId: ctx.user.id };
  const sub = await subAccountFor(ctx.orgId, Number(fd.get("bandId")));
  if (!sub) throw new Error("This band doesn’t have an account from the label.");
  return { bandOrgId: sub.org.id, labelOrgId: ctx.orgId, bandId: sub.link.labelBandId, userId: ctx.user.id };
}

function refresh(bandId: number) {
  revalidatePath("/account");
  revalidatePath("/directory");
  revalidatePath(`/bands/${bandId}`);
}

/** A new single-use link to the band's account. Whoever uses it says who they are when they join. */
export async function createInviteLink(_: InviteLinkState, fd: FormData): Promise<InviteLinkState> {
  let a;
  try {
    a = await bandAccountFor(fd);
  } catch (e) {
    return { error: (e as Error).message };
  }
  const id = randomUUID();
  await db.insert(schema.bandInviteLinks).values({
    id,
    orgId: a.bandOrgId,
    createdByUserId: a.userId,
    expiresAt: stamp(new Date(Date.now() + INVITE_LINK_DAYS * 86_400_000)),
  });
  refresh(a.bandId);
  return { ok: "Invite link made.", url: `${process.env.BETTER_AUTH_URL ?? ""}/join/${id}` };
}

export async function cancelInviteLink(fd: FormData) {
  const a = await bandAccountFor(fd);
  await db
    .update(schema.bandInviteLinks)
    .set({ canceledAt: stamp(new Date()) })
    .where(and(eq(schema.bandInviteLinks.id, String(fd.get("id"))), eq(schema.bandInviteLinks.orgId, a.bandOrgId)));
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
  // Claim it first, so the same link can't be used twice at once.
  const claimed = await db
    .update(schema.bandInviteLinks)
    .set({ usedAt: now, usedByUserId: userId })
    .where(
      and(
        eq(schema.bandInviteLinks.id, id),
        eq(schema.bandInviteLinks.orgId, band.id),
        isNull(schema.bandInviteLinks.usedAt),
        isNull(schema.bandInviteLinks.canceledAt),
      ),
    )
    .returning({ id: schema.bandInviteLinks.id });
  if (!claimed.length) return { error: "This invite link was just used." };
  const [already] = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, band.id), eq(schema.member.userId, userId)));
  if (!already) {
    await db.insert(schema.member).values({ id: randomUUID(), organizationId: band.id, userId, role: "admin", createdAt: new Date() });
  }
  if (choice === "new") {
    // Someone not in the label's books yet: a new member of the band.
    const [p] = await db.insert(schema.people).values({ orgId: labelOrgId, name: newName }).returning({ id: schema.people.id });
    await db.insert(schema.bandMemberships).values({ orgId: labelOrgId, bandId, personId: p.id, roles: [], active: true });
    personId = p.id;
  }
  if (personId) {
    await db
      .insert(schema.bandLoginPeople)
      .values({ orgId: band.id, userId, personId })
      .onConflictDoUpdate({ target: [schema.bandLoginPeople.orgId, schema.bandLoginPeople.userId], set: { personId } });
  }
  // Straight into the band's account (through Better Auth, so the cached session cookie follows).
  await auth.api.setActiveOrganization({ body: { organizationId: band.id }, headers: await headers() });
  revalidatePath("/", "layout");
  redirect("/");
}

/**
 * Turn one of a band account's member logins into the band's shared login (it stops being that
 * member's). Only when the band has no shared login yet. A login that belongs to nothing else takes
 * the band's name.
 */
export async function makeSharedLogin(fd: FormData) {
  const a = await bandAccountFor(fd);
  const userId = String(fd.get("userId") ?? "");
  const [login] = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, a.bandOrgId), eq(schema.member.userId, userId)));
  if (!login) throw new Error("That login isn’t one of the band’s.");
  if (await hasSharedLogin(a.bandOrgId)) throw new Error("The band already has its shared login.");
  await db.delete(schema.bandLoginPeople).where(and(eq(schema.bandLoginPeople.orgId, a.bandOrgId), eq(schema.bandLoginPeople.userId, userId)));
  const elsewhere = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(and(eq(schema.member.userId, userId), ne(schema.member.organizationId, a.bandOrgId)));
  if (!elsewhere.length) {
    const [band] = await db.select({ name: schema.organization.name }).from(schema.organization).where(eq(schema.organization.id, a.bandOrgId));
    if (band) await db.update(schema.user).set({ name: band.name }).where(eq(schema.user.id, userId));
  }
  refresh(a.bandId);
  revalidatePath("/", "layout");
}

/** Say which member one of the band's logins is (one who doesn't have a login of their own yet). */
export async function linkLoginToMember(fd: FormData) {
  const a = await bandAccountFor(fd);
  const userId = String(fd.get("userId") ?? "");
  const personId = Number(fd.get("personId"));
  const [login] = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, a.bandOrgId), eq(schema.member.userId, userId)));
  if (!login) throw new Error("That login isn’t one of the band’s.");
  if (!(await unclaimedMembers(a.bandOrgId, a.labelOrgId, a.bandId)).some((p) => p.id === personId)) {
    throw new Error("That member already has a login. Choose someone else.");
  }
  await db
    .insert(schema.bandLoginPeople)
    .values({ orgId: a.bandOrgId, userId, personId })
    .onConflictDoUpdate({ target: [schema.bandLoginPeople.orgId, schema.bandLoginPeople.userId], set: { personId } });
  refresh(a.bandId);
  revalidatePath("/", "layout");
}
