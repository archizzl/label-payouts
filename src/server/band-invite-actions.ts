"use server";

import { randomUUID } from "node:crypto";
import { and, eq, isNull, ne } from "drizzle-orm";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import { subAccountFor } from "./band-accounts";
import { hasSharedLogin, resetStandingLink, stamp, unclaimedMembers, unclaimedPeople, usableInviteLink } from "./band-invite-links";
import { applyMyDetails } from "./people";
import { syncOwnPeople } from "./own-books";
import { ownBand } from "./data";
import { auth } from "./auth";
import { cleanCashtag, cleanVenmoHandle } from "@/lib/paypal-export";
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
  revalidatePath("/settings");
  revalidatePath("/directory");
  revalidatePath(`/bands/${bandId}`);
}

/** Reset the band's standing invite link: the old one stops working. */
export async function resetInviteLink(fd: FormData) {
  const a = await bandAccountFor(fd);
  await resetStandingLink(a.bandOrgId, a.userId);
  refresh(a.bandId);
}

/**
 * Use an invite link: the signed-in login joins the band's account (or the label's), then works in
 * it. Whatever they filled in of their details (name, how they're paid) is saved to every payee
 * record that's theirs, the one they joined as included; blank fields leave things as they are.
 */
export async function joinWithInviteLink(_: InviteLinkState, fd: FormData): Promise<InviteLinkState> {
  const id = String(fd.get("id") ?? "");
  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(`/join/${id}`)}`);
  const found = await usableInviteLink(id);
  if (!found) return { error: "This invite link has been used, cancelled or has expired. Ask for a new one." };
  const { link, band: org, labelOrgId } = found;
  const userId = session.user.id;
  const now = stamp(new Date());
  const field = (k: string) => String(fd.get(k) ?? "").trim().slice(0, 200);
  // Who they are: the member the link names, one they picked (who has no login of their own yet),
  // someone new, or (a band) the band itself, its shared login.
  const choice = link.personId ? String(link.personId) : String(fd.get("as") ?? "");
  const newName = field("name").slice(0, 120);
  let personId: number | null = null;
  if (choice === "new") {
    if (!newName) return { error: "Enter your name." };
  } else if (choice === "band" && !found.forLabel) {
    // One shared login per band.
    if (await hasSharedLogin(org.id)) return { error: `${org.name} already has its shared login. Choose who you are.` };
  } else {
    personId = Number(choice) || null;
    // Each person has at most one login of their own.
    const open = found.forLabel ? await unclaimedPeople(labelOrgId) : await unclaimedMembers(org.id, labelOrgId, found.bandId);
    if (!personId || !open.some((p) => p.id === personId)) return { error: "That person already has a login. Choose who you are." };
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
    .where(and(eq(schema.member.organizationId, org.id), eq(schema.member.userId, userId)));
  if (!already) {
    // The band's own login manages the account; everyone else's just uses it (a label's admins
    // choose roles under Who can sign in).
    await db.insert(schema.member).values({ id: randomUUID(), organizationId: org.id, userId, role: choice === "band" ? "admin" : "member", createdAt: new Date() });
  }
  // What they filled in of their details (blank: left as it is).
  const opt = (k: string) => field(k) || undefined;
  const details = {
    name: newName || undefined,
    email: opt("email"),
    paypalMe: opt("paypalMe"),
    venmo: cleanVenmoHandle(field("venmo")) || undefined,
    cashtag: cleanCashtag(field("cashtag")) || undefined,
  };
  if (choice === "new") {
    // Someone not in the label's books yet: with the details they gave, and (a band) what they do in it.
    const [p] = await db
      .insert(schema.people)
      .values({
        orgId: labelOrgId,
        name: newName,
        email: details.email ?? null,
        paypalMe: details.paypalMe ?? null,
        venmo: details.venmo ?? null,
        cashtag: details.cashtag ?? null,
        // On a label, their payee record is linked to their login directly.
        userId: found.forLabel ? userId : null,
      })
      .returning({ id: schema.people.id });
    // In the band they joined: a label's band, or the band that runs its own account.
    const bandId = found.forLabel ? (org.kind === "band" ? (await ownBand(org.id))?.id : null) : found.bandId;
    if (bandId) {
      const role = field("role");
      await db.insert(schema.bandMemberships).values({ orgId: labelOrgId, bandId, personId: p.id, roles: role ? [role] : [], active: true });
    }
    personId = p.id;
  } else if (personId && found.forLabel) {
    const linked = await db
      .update(schema.people)
      .set({ userId })
      .where(and(eq(schema.people.orgId, labelOrgId), eq(schema.people.id, personId), isNull(schema.people.userId)))
      .returning({ id: schema.people.id });
    if (!linked.length) return { error: "That person already has a login. Choose who you are." };
  }
  if (personId && !found.forLabel) {
    try {
      await db
        .insert(schema.bandLoginPeople)
        .values({ orgId: org.id, userId, personId })
        .onConflictDoUpdate({ target: [schema.bandLoginPeople.orgId, schema.bandLoginPeople.userId], set: { personId } });
    } catch {
      // Someone else just took that member (one login per member).
      return { error: "That member already has a login. Choose who you are." };
    }
  }
  // A band that keeps its own books too: they're in those as well, linked to this login.
  if (!found.forLabel) await syncOwnPeople(org.id);
  if (personId) {
    // Everywhere they're someone, the one they just joined as included.
    await applyMyDetails(userId, details);
    // Their login's name: what they gave, or (a login still going by the band's name, from signing
    // up through the link) the name the label has for them.
    let name = details.name;
    if (!name && session.user.name === org.name) {
      const [p] = await db.select({ name: schema.people.name }).from(schema.people).where(eq(schema.people.id, personId));
      name = p?.name;
    }
    if (name && name !== session.user.name) await auth.api.updateUser({ body: { name }, headers: await headers() });
  }
  // Straight into the account (through Better Auth, so the cached session cookie follows).
  await auth.api.setActiveOrganization({ body: { organizationId: org.id }, headers: await headers() });
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
