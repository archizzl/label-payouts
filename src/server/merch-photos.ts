import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { discardStoredFiles, storeFile } from "./receipt-store";

/*
 * Photos uploaded for merch without one from Bandcamp. A catalog item's art_url points at its photo
 * (so everywhere that shows artwork shows it); stock outside the catalog keeps its photo_id. Bandcamp
 * wins: a photo it has later replaces an uploaded one (src/server/bandcamp.ts keeps ours otherwise).
 */

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const PHOTO_TYPES = /^image\/(jpeg|png|gif|webp)$/;
const PREFIX = "/merch/photo/";

/** Where an uploaded photo is shown. */
export const merchPhotoUrl = (id: number) => `${PREFIX}${id}`;

/** The uploaded photo an address points at, if it's one of ours. */
export function ownPhotoId(url: string | null | undefined): number | null {
  if (!url?.startsWith(PREFIX)) return null;
  return Number(url.slice(PREFIX.length)) || null;
}

/** The photo on a form (field "photo"), checked, or null if none was picked. Throws a readable error. */
export function photoFrom(fd: FormData): File | null {
  const f = fd.get("photo");
  if (!(f instanceof File) || f.size === 0) return null;
  if (!PHOTO_TYPES.test(f.type)) throw new Error("The photo must be a JPEG, PNG, GIF or WebP.");
  if (f.size > MAX_PHOTO_BYTES) throw new Error("The photo is over 10 MB.");
  return f;
}

/** Keep an uploaded photo; returns its id. */
export async function saveMerchPhoto(orgId: string, file: File): Promise<number> {
  const stored = await storeFile(`merch/${orgId}`, file, file.type);
  try {
    const [row] = await db
      .insert(schema.merchPhotos)
      .values({ orgId, contentType: file.type, size: file.size, ...stored })
      .returning({ id: schema.merchPhotos.id });
    return row.id;
  } catch (e) {
    await discardStoredFiles([stored]);
    throw e;
  }
}

/** Delete a photo that's no longer used (its file too). */
export async function deleteMerchPhoto(orgId: string, id: number | null) {
  if (!id) return;
  const [row] = await db
    .delete(schema.merchPhotos)
    .where(and(eq(schema.merchPhotos.orgId, orgId), eq(schema.merchPhotos.id, id)))
    .returning({ storageKey: schema.merchPhotos.storageKey });
  if (row) await discardStoredFiles([row]);
}
