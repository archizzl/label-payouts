"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { bandScope } from "@/lib/permissions";
import { requireAccess } from "./context";
import { deleteMerchPhoto, merchPhotoUrl, ownPhotoId, photoFrom, saveMerchPhoto } from "./merch-photos";

export type PhotoState = { ok?: string; error?: string } | null;

const { releases } = schema;

/** The catalog item, if it's one they can change and it has no photo from Bandcamp. */
async function editableRelease(fd: FormData) {
  const ctx = await requireAccess("catalog", "edit");
  const [r] = await db
    .select({ id: releases.id, bandId: releases.bandId, artUrl: releases.artUrl })
    .from(releases)
    .where(and(eq(releases.orgId, ctx.orgId), eq(releases.id, Number(fd.get("id")))));
  const scope = bandScope(ctx.access, "catalog");
  if (!r || (scope && !scope.includes(r.bandId))) throw new Error("That item isn’t in this group.");
  if (r.artUrl && !ownPhotoId(r.artUrl)) throw new Error("It has a photo from Bandcamp.");
  return { orgId: ctx.orgId, release: r };
}

/** Upload a photo for a catalog item that has none from Bandcamp (replacing one uploaded before). */
export async function setReleasePhoto(_: PhotoState, fd: FormData): Promise<PhotoState> {
  try {
    const { orgId, release } = await editableRelease(fd);
    const file = photoFrom(fd);
    if (!file) return { error: "Choose a photo." };
    const photoId = await saveMerchPhoto(orgId, file);
    await db.update(releases).set({ artUrl: merchPhotoUrl(photoId) }).where(eq(releases.id, release.id));
    await deleteMerchPhoto(orgId, ownPhotoId(release.artUrl));
    revalidatePath("/", "layout");
    return { ok: "Photo saved." };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Take an uploaded photo off a catalog item. */
export async function removeReleasePhoto(_: PhotoState, fd: FormData): Promise<PhotoState> {
  try {
    const { orgId, release } = await editableRelease(fd);
    await db.update(releases).set({ artUrl: null }).where(eq(releases.id, release.id));
    await deleteMerchPhoto(orgId, ownPhotoId(release.artUrl));
    revalidatePath("/", "layout");
    return { ok: "Photo removed." };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
