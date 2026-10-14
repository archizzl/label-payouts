"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { BAND_MEMBER_COOKIE, bandMembers } from "./band-member";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { accountContext, requireAdmin } from "./context";
import { subAccountFor } from "./band-accounts";

/** In a band account the label made: say which member of the band is using it. */
export async function chooseBandMember(fd: FormData) {
  const ctx = await accountContext();
  const m = ctx.managedBy;
  if (!m) throw new Error("Only a band’s account has members to choose from.");
  const id = Number(fd.get("personId"));
  if (!(await bandMembers(m.labelOrgId, m.bandId)).some((p) => p.id === id)) throw new Error("Pick someone in the band.");
  (await cookies()).set(BAND_MEMBER_COOKIE, `${ctx.orgId}|${id}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 365 * 86_400,
  });
  revalidatePath("/", "layout");
  // From Settings, stay there; from the switcher at the top, go to their home page.
  redirect(fd.get("back") === "/account" ? "/account" : `/from-label/${m.linkId}`);
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
