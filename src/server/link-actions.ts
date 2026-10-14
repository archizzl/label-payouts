"use server";

import { randomUUID } from "node:crypto";
import { and, eq, gt, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { subAccountFor } from "./band-accounts";
import { requireAdmin } from "./context";

const { accountLinks } = schema;

export type LinkState = { ok?: string; error?: string } | null;

/** Either side can end a link (or the label can cancel a code that hasn't been used). */
export async function unlink(fd: FormData) {
  const ctx = await requireAdmin();
  await db
    .delete(accountLinks)
    .where(
      and(
        eq(accountLinks.id, Number(fd.get("id"))),
        or(eq(accountLinks.labelOrgId, ctx.orgId), eq(accountLinks.bandOrgId, ctx.orgId)),
        // A sub-account the label made stays linked: it goes when the band does.
        eq(accountLinks.managed, false),
      ),
    );
  revalidatePath("/", "layout");
}

const INVITE_DAYS = 14;

/**
 * Label admin: invite someone to a band's sub-account, as an admin of it (a band's people run their
 * own account). There's no email sending: the label copies the link from the band's page.
 */
export async function inviteToBandAccount(_: LinkState, fd: FormData): Promise<LinkState> {
  const ctx = await requireAdmin();
  const sub = await subAccountFor(ctx.orgId, Number(fd.get("bandId")));
  if (!sub) return { error: "This band doesn't have an account from the label." };
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  if (!email.includes("@")) return { error: "Enter their email address." };
  const [already] = await db
    .select({ id: schema.invitation.id })
    .from(schema.invitation)
    .where(and(eq(schema.invitation.organizationId, sub.org.id), eq(schema.invitation.email, email), eq(schema.invitation.status, "pending")));
  if (already) return { error: `${email} already has an invite waiting.` };
  // One login for the whole band: its members pick which of them they are once signed in.
  const [login] = await db.select({ id: schema.member.id }).from(schema.member).where(eq(schema.member.organizationId, sub.org.id));
  const [waiting] = await db
    .select({ id: schema.invitation.id })
    .from(schema.invitation)
    .where(and(eq(schema.invitation.organizationId, sub.org.id), eq(schema.invitation.status, "pending"), gt(schema.invitation.expiresAt, new Date())));
  if (login || waiting) return { error: `${sub.org.name} already has its login. The whole band shares it.` };
  await db.insert(schema.invitation).values({
    id: randomUUID(),
    organizationId: sub.org.id,
    email,
    role: "admin",
    status: "pending",
    expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
    inviterId: ctx.user.id,
  });
  revalidatePath(`/bands/${sub.link.labelBandId}`);
  revalidatePath("/directory");
  return { ok: `Invited ${email}.` };
}

/** Label admin: cancel an invite to one of its bands' sub-accounts. */
export async function cancelBandAccountInvite(fd: FormData) {
  const ctx = await requireAdmin();
  const sub = await subAccountFor(ctx.orgId, Number(fd.get("bandId")));
  if (!sub) throw new Error("This band doesn't have an account from the label.");
  await db
    .update(schema.invitation)
    .set({ status: "canceled" })
    .where(and(eq(schema.invitation.id, String(fd.get("id"))), eq(schema.invitation.organizationId, sub.org.id)));
  revalidatePath(`/bands/${sub.link.labelBandId}`);
  revalidatePath("/directory");
}
