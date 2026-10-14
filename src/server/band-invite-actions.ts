"use server";

import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import { subAccountFor } from "./band-accounts";
import { INVITE_LINK_DAYS, stamp, usableInviteLink } from "./band-invite-links";
import { bandMembers } from "./band-member";
import { auth } from "./auth";
import { getSession, requireAdmin } from "./context";

export type InviteLinkState = { ok?: string; error?: string } | null;

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

/** A new single-use link to sign in as the band, or (with personId) as one of its members. */
export async function createInviteLink(_: InviteLinkState, fd: FormData): Promise<InviteLinkState> {
  let a;
  try {
    a = await bandAccountFor(fd);
  } catch (e) {
    return { error: (e as Error).message };
  }
  const personId = Number(fd.get("personId")) || null;
  if (personId && !(await bandMembers(a.labelOrgId, a.bandId)).some((p) => p.id === personId)) return { error: "Pick someone in the band." };
  await db.insert(schema.bandInviteLinks).values({
    id: randomUUID(),
    orgId: a.bandOrgId,
    personId,
    createdByUserId: a.userId,
    expiresAt: stamp(new Date(Date.now() + INVITE_LINK_DAYS * 86_400_000)),
  });
  refresh(a.bandId);
  return { ok: "Invite link made. Copy it and send it to them." };
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
  const { link, band } = found;
  const userId = session.user.id;
  const now = stamp(new Date());
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
  if (link.personId) {
    await db
      .insert(schema.bandLoginPeople)
      .values({ orgId: band.id, userId, personId: link.personId })
      .onConflictDoUpdate({ target: [schema.bandLoginPeople.orgId, schema.bandLoginPeople.userId], set: { personId: link.personId } });
  }
  // Straight into the band's account (through Better Auth, so the cached session cookie follows).
  await auth.api.setActiveOrganization({ body: { organizationId: band.id }, headers: await headers() });
  revalidatePath("/", "layout");
  redirect("/");
}
