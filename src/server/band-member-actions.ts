"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { BAND_MEMBER_COOKIE, bandMembers } from "./band-member";
import { getContext } from "./context";

/** In a band account the label made: say which member of the band is using it. */
export async function chooseBandMember(fd: FormData) {
  const ctx = await getContext();
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
  redirect(`/from-label/${m.linkId}`);
}
