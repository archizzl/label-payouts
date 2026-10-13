"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { realContext, VIEW_AS_COOKIE, viewAsValue } from "./context";

/**
 * Label admins: see the app as one of the label's bands (its sub-account) or one of its people. It's
 * read-only, lasts until they stop (or for a few hours), and is checked again on every request.
 */
export async function startViewAs(fd: FormData) {
  const ctx = await realContext();
  const kind = fd.get("kind") === "band" ? "band" : "person";
  const id = Number(fd.get("id"));
  if (ctx.org.kind !== "label" || !ctx.isAdmin) throw new Error("Only a label's admins can view as its bands and people.");
  if (!Number.isInteger(id) || id <= 0) throw new Error("Pick a band or person to view as.");
  (await cookies()).set(VIEW_AS_COOKIE, viewAsValue(ctx.orgId, kind, id), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 4 * 60 * 60,
  });
  revalidatePath("/", "layout");
  redirect(kind === "person" ? "/me" : "/");
}

/** Back to being yourself, on the page you started from. */
export async function stopViewAs(fd: FormData) {
  (await cookies()).delete(VIEW_AS_COOKIE);
  revalidatePath("/", "layout");
  const back = String(fd.get("back") ?? "/");
  redirect(back.startsWith("/") && !back.startsWith("//") ? back : "/");
}
