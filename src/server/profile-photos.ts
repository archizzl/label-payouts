import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { discardStoredFiles, storeFile } from "./receipt-store";

/*
 * Profile photos: one per account (a login), uploaded on Account. The account's own image points at
 * /account/photo/[id], so wherever a person with a login is shown (the header, the Directory, who
 * can sign in), their photo can be.
 */

const PREFIX = "/account/photo/";

export const profilePhotoUrl = (id: number) => `${PREFIX}${id}`;

/** Make this the account's photo (the one before goes). */
export async function setProfilePhoto(userId: string, file: File) {
  const stored = await storeFile(`profiles/${userId}`, file, file.type);
  let id: number;
  try {
    [{ id }] = await db
      .insert(schema.profilePhotos)
      .values({ userId, contentType: file.type, size: file.size, ...stored })
      .returning({ id: schema.profilePhotos.id });
  } catch (e) {
    await discardStoredFiles([stored]);
    throw e;
  }
  await db.update(schema.user).set({ image: profilePhotoUrl(id) }).where(eq(schema.user.id, userId));
  await clearOldPhotos(userId, id);
}

/** Take the account's photo off. */
export async function removeProfilePhoto(userId: string) {
  await db.update(schema.user).set({ image: null }).where(eq(schema.user.id, userId));
  await clearOldPhotos(userId, null);
}

/** Delete an account's photos other than `keep` (their files too). */
export async function clearOldPhotos(userId: string, keep: number | null) {
  const rows = await db.select({ id: schema.profilePhotos.id, storageKey: schema.profilePhotos.storageKey }).from(schema.profilePhotos).where(eq(schema.profilePhotos.userId, userId));
  const old = rows.filter((r) => r.id !== keep);
  for (const r of old) await db.delete(schema.profilePhotos).where(eq(schema.profilePhotos.id, r.id));
  await discardStoredFiles(old);
}
