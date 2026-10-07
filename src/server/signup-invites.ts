import "server-only";
import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";

/*
 * Who may create a login: only someone with a signup invite (made by a site admin on /admin), or
 * someone invited into an existing label or band account (the team invite links). Checked by Better
 * Auth itself whenever a user would be created (src/server/auth.ts), so no sign-up route can skip it.
 */

const { signupInvites, invitation } = schema;
const nowIso = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const normalize = (email: string) => email.trim().toLowerCase();

export type InviteCheck = { ok: true; code: string | null } | { ok: false; reason: string };

/** A signup invite by its code, if it can still be used. */
export async function usableInvite(code: string) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(code)) return null;
  const [row] = await db
    .select()
    .from(signupInvites)
    .where(and(eq(signupInvites.code, code), isNull(signupInvites.usedAt), isNull(signupInvites.revokedAt), gt(signupInvites.expiresAt, nowIso())));
  return row ?? null;
}

/** May this email create a login, with this code (if any)? */
export async function checkSignup(email: string, code: string | null): Promise<InviteCheck> {
  const e = normalize(email);
  if (code) {
    const invite = await usableInvite(code);
    if (!invite) return { ok: false, reason: "This invite link has been used, revoked or has expired. Ask for a new one." };
    if (invite.email && invite.email !== e) return { ok: false, reason: `This invite is for ${invite.email}. Use that email, or ask for a new invite.` };
    return { ok: true, code };
  }
  // Invited into an existing account (the team invite links): that email may sign up.
  const [pending] = await db
    .select({ id: invitation.id })
    .from(invitation)
    .where(and(sql`lower(${invitation.email}) = ${e}`, eq(invitation.status, "pending"), gt(invitation.expiresAt, new Date())))
    .limit(1);
  if (pending) return { ok: true, code: null };
  return { ok: false, reason: "Signing up is by invitation only. Ask the label for an invite link." };
}

/** Use up a code for a new login. Only the first use counts. */
export async function consumeInvite(code: string, userId: string) {
  const [row] = await db
    .update(signupInvites)
    .set({ usedAt: nowIso(), usedByUserId: userId })
    .where(and(eq(signupInvites.code, code), isNull(signupInvites.usedAt), isNull(signupInvites.revokedAt)))
    .returning({ id: signupInvites.id });
  return !!row;
}

/** A new invite: a long random code, for anyone (or one email), expiring after `days`. */
export async function createInvite({ email, note, days, createdBy }: { email?: string | null; note?: string | null; days: number; createdBy: string | null }) {
  const code = randomBytes(18).toString("base64url");
  const expires = new Date(Date.now() + Math.min(365, Math.max(1, days)) * 86_400_000).toISOString().replace("T", " ").slice(0, 19);
  const [row] = await db
    .insert(signupInvites)
    .values({ code, email: email ? normalize(email) : null, note: note || null, expiresAt: expires, createdByUserId: createdBy })
    .returning();
  return row;
}

export async function revokeInvite(id: number) {
  await db.update(signupInvites).set({ revokedAt: nowIso() }).where(and(eq(signupInvites.id, id), isNull(signupInvites.usedAt)));
}

export async function listInvites() {
  return db.select().from(signupInvites).orderBy(desc(signupInvites.id)).limit(200);
}

export function inviteStatus(i: typeof signupInvites.$inferSelect): "used" | "revoked" | "expired" | "open" {
  if (i.usedAt) return "used";
  if (i.revokedAt) return "revoked";
  if (i.expiresAt <= nowIso()) return "expired";
  return "open";
}
