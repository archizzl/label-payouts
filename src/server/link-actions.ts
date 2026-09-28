"use server";

import { randomInt } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import { requireAdmin } from "./context";

const { accountLinks, bands } = schema;

export type LinkState = { ok?: string; error?: string } | null;

/** Easy to read out or type: no 0/O or 1/I. */
function newCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const part = () => Array.from({ length: 4 }, () => chars[randomInt(chars.length)]).join("");
  return `${part()}-${part()}-${part()}`;
}

/** Label admin: a code for one of the label's bands, to send to that band's own account. */
export async function createLinkCode(fd: FormData) {
  const ctx = await requireAdmin();
  const bandId = Number(fd.get("bandId"));
  const [band] = await db
    .select()
    .from(bands)
    .where(and(eq(bands.orgId, ctx.orgId), eq(bands.id, bandId)));
  if (!band) throw new Error("Band not found.");
  const [existing] = await db.select().from(accountLinks).where(eq(accountLinks.labelBandId, bandId));
  if (existing?.status === "active") throw new Error(`${band.name} is already linked. Unlink it first.`);
  if (existing) await db.delete(accountLinks).where(eq(accountLinks.id, existing.id));
  await db.insert(accountLinks).values({ labelOrgId: ctx.orgId, labelBandId: bandId, code: newCode(), createdByUserId: ctx.user.id });
  revalidatePath("/", "layout");
}

/** Band account admin: accept a label's code. */
export async function acceptLinkCode(_: LinkState, fd: FormData): Promise<LinkState> {
  const ctx = await requireAdmin();
  if (ctx.org.kind !== "band") return { error: "Only band accounts can link to a label." };
  const code = String(fd.get("code") ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/(.{4})(?=.)/g, "$1-");
  const [link] = await db
    .select()
    .from(accountLinks)
    .where(and(eq(accountLinks.code, code), eq(accountLinks.status, "pending")));
  if (!link) return { error: "That code isn't valid. Check it, or ask the label for a new one." };
  if (link.labelOrgId === ctx.orgId) return { error: "That code is for this account." };
  await db
    .update(accountLinks)
    .set({ bandOrgId: ctx.orgId, status: "active", acceptedAt: new Date().toISOString() })
    .where(eq(accountLinks.id, link.id));
  revalidatePath("/", "layout");
  redirect(`/from-label/${link.id}`);
}

/** Either side can end a link (or the label can cancel a code that hasn't been used). */
export async function unlink(fd: FormData) {
  const ctx = await requireAdmin();
  await db
    .delete(accountLinks)
    .where(and(eq(accountLinks.id, Number(fd.get("id"))), or(eq(accountLinks.labelOrgId, ctx.orgId), eq(accountLinks.bandOrgId, ctx.orgId))));
  revalidatePath("/", "layout");
}
