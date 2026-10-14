"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { BAND_MEMBER_COOKIE, bandMembers } from "./band-member";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { cleanCashtag, cleanVenmoHandle } from "@/lib/paypal-export";
import { accountContext, requireAdmin } from "./context";
import { subAccountFor } from "./band-accounts";

/** In a band account the label made: say which member of the band is using it. */
export async function chooseBandMember(fd: FormData) {
  const ctx = await accountContext();
  const m = ctx.managedBy;
  if (!m) throw new Error("Only a band’s account has members to choose from.");
  // "band": the whole band, nobody in particular.
  const raw = String(fd.get("personId") ?? "");
  const id = Number(raw);
  if (raw !== "band" && !(await bandMembers(m.labelOrgId, m.bandId)).some((p) => p.id === id)) throw new Error("Pick someone in the band.");
  (await cookies()).set(BAND_MEMBER_COOKIE, `${ctx.orgId}|${raw === "band" ? "band" : id}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 365 * 86_400,
  });
  revalidatePath("/", "layout");
  redirect(`/from-label/${m.linkId}`);
}

/**
 * Which member a band's shared login opens as, until whoever's using it picks someone else. Set by the
 * label (for one of its bands) or by the band account itself. Blank: they pick each time.
 */
export async function setBandDefaultMember(fd: FormData) {
  const ctx = await requireAdmin();
  let link: { id: number; labelOrgId: string; bandId: number };
  if (ctx.managedBy) {
    link = { id: ctx.managedBy.linkId, labelOrgId: ctx.managedBy.labelOrgId, bandId: ctx.managedBy.bandId };
  } else {
    const sub = await subAccountFor(ctx.orgId, Number(fd.get("bandId")));
    if (!sub) throw new Error("This band doesn’t have an account from the label.");
    link = { id: sub.link.id, labelOrgId: ctx.orgId, bandId: sub.link.labelBandId };
  }
  const id = Number(fd.get("personId")) || null;
  if (id && !(await bandMembers(link.labelOrgId, link.bandId)).some((p) => p.id === id)) throw new Error("Pick someone in the band.");
  await db
    .update(schema.accountLinks)
    .set({ defaultPersonId: id })
    .where(and(eq(schema.accountLinks.id, link.id), eq(schema.accountLinks.labelOrgId, link.labelOrgId)));
  revalidatePath("/", "layout");
}

export type DetailsState = { ok?: string; error?: string } | null;

/**
 * A member's own login on a band's account: update their details in the label's books (name, their
 * roles in this band, and how they're paid). Only their own record, never anyone else's.
 */
export async function saveMyDetails(_: DetailsState, fd: FormData): Promise<DetailsState> {
  const ctx = await accountContext();
  const m = ctx.managedBy;
  if (!m) return { error: "Only a band member’s own login has details to change here." };
  const [own] = await db
    .select({ personId: schema.bandLoginPeople.personId })
    .from(schema.bandLoginPeople)
    .where(and(eq(schema.bandLoginPeople.orgId, ctx.orgId), eq(schema.bandLoginPeople.userId, ctx.user.id)));
  if (!own) return { error: "This login is the band’s, not one member’s." };
  const text = (k: string) => String(fd.get(k) ?? "").trim().slice(0, 200);
  const name = text("name");
  if (!name) return { error: "Enter your name." };
  await db
    .update(schema.people)
    .set({
      name,
      email: text("email") || null,
      paypalMe: text("paypalMe").replace(/^(https?:\/\/)?(www\.)?paypal\.me\//i, "") || null,
      venmo: cleanVenmoHandle(text("venmo")) || null,
      cashtag: cleanCashtag(text("cashtag")) || null,
    })
    .where(and(eq(schema.people.orgId, m.labelOrgId), eq(schema.people.id, own.personId)));
  const roles = text("roles")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  await db
    .update(schema.bandMemberships)
    .set({ roles })
    .where(and(eq(schema.bandMemberships.orgId, m.labelOrgId), eq(schema.bandMemberships.bandId, m.bandId), eq(schema.bandMemberships.personId, own.personId)));
  revalidatePath("/", "layout");
  return { ok: "Saved." };
}
