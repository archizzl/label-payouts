"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
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
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) redirect("/admin?error=email");
  const invite = await createInvite({ email: email || null, note: str(fd, "note").slice(0, 200) || null, days: Number(str(fd, "days")) || 14, createdBy: session.user.id });
  revalidatePath("/admin");
  redirect(`/admin?created=${invite.id}`);
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
  if (!u) return { error: "No such login." };
  const link = await makeResetLink(u.email);
  return link ? { ok: `Reset link for ${u.email} (works once, for 24 hours):`, link } : { error: "Couldn’t make a reset link." };
}
