"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { FLAG_AUDIENCES, isFeatureFlag, isFlagAudience } from "@/lib/feature-flags";
import { makeResetLink } from "./auth";
import { requireSiteAdmin } from "./site-admin";
import { createInvite, revokeInvite } from "./signup-invites";

/*
 * The site admin dashboard's actions: invite links for new logins, and password reset links.
 * Site admins only (SITE_ADMIN_EMAILS).
 */

export type AdminState = { ok?: string; error?: string; link?: string } | null;

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

export async function createSignupInvite(fd: FormData) {
  const session = await requireSiteAdmin();
  const email = str(fd, "email");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) redirect("/admin?tab=invites&error=email");
  const invite = await createInvite({ email: email || null, note: str(fd, "note").slice(0, 200) || null, days: Number(str(fd, "days")) || 14, createdBy: session.user.id });
  revalidatePath("/admin");
  redirect(`/admin?tab=invites&created=${invite.id}`);
}

export async function revokeSignupInvite(fd: FormData) {
  await requireSiteAdmin();
  await revokeInvite(Number(str(fd, "id")));
  revalidatePath("/admin");
}

/** A one-time link (24 hours) for someone to choose a new password; the admin sends it to them. */
export async function passwordResetLink(_: AdminState, fd: FormData): Promise<AdminState> {
  await requireSiteAdmin();
  const [u] = await db.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.id, str(fd, "userId")));
  if (!u) return { error: "No such account." };
  const link = await makeResetLink(u.email);
  return link ? { ok: `Reset link for ${u.email} (works once, for 24 hours):`, link } : { error: "Couldn’t make a reset link." };
}

/**
 * A flagged feature: whether it shows for this site admin, and which groups, accounts and kinds of
 * account have it. Replaces the lists with the ones sent.
 */
export async function saveFeatureFlag(_: AdminState, fd: FormData): Promise<AdminState> {
  const session = await requireSiteAdmin();
  const flag = str(fd, "flag");
  if (!isFeatureFlag(flag)) return { error: "Unknown feature." };
  const sent = (k: string) => [...new Set(fd.getAll(k).map(String).filter(Boolean))];
  const orgIds = sent("org");
  const userIds = sent("user");
  const audiences = sent("audience").filter(isFlagAudience);
  const [orgs, users] = await Promise.all([
    orgIds.length ? db.select({ id: schema.organization.id }).from(schema.organization).where(inArray(schema.organization.id, orgIds)) : [],
    userIds.length ? db.select({ id: schema.user.id }).from(schema.user).where(inArray(schema.user.id, userIds)) : [],
  ]);
  const enabled = fd.get("me") === "on";
  await db.transaction(async (tx) => {
    await tx
      .insert(schema.featureFlagPrefs)
      .values({ flag, userId: session.user.id, enabled })
      .onConflictDoUpdate({ target: [schema.featureFlagPrefs.flag, schema.featureFlagPrefs.userId], set: { enabled } });
    await tx.delete(schema.featureFlagAccounts).where(eq(schema.featureFlagAccounts.flag, flag));
    await tx.delete(schema.featureFlagUsers).where(eq(schema.featureFlagUsers.flag, flag));
    await tx.delete(schema.featureFlagAudiences).where(eq(schema.featureFlagAudiences.flag, flag));
    if (orgs.length) await tx.insert(schema.featureFlagAccounts).values(orgs.map((o) => ({ flag, orgId: o.id })));
    if (users.length) await tx.insert(schema.featureFlagUsers).values(users.map((u) => ({ flag, userId: u.id })));
    if (audiences.length) await tx.insert(schema.featureFlagAudiences).values(audiences.map((audience) => ({ flag, audience })));
  });
  revalidatePath("/", "layout");
  return { ok: `Saved. ${whoHasIt({ groups: orgs.length, accounts: users.length, audiences })}` };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "Given to 2 groups, 1 account and owners and admins." */
function whoHasIt({ groups, accounts, audiences }: { groups: number; accounts: number; audiences: string[] }) {
  if (audiences.includes("everyone")) return "Given to everyone.";
  const parts = [
    groups && plural(groups, "group"),
    accounts && plural(accounts, "account"),
    ...FLAG_AUDIENCES.filter((a) => audiences.includes(a.key)).map((a) => a.label.toLowerCase()),
  ].filter((p): p is string => !!p);
  if (!parts.length) return "Not given to anyone.";
  return `Given to ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`}.`;
}
