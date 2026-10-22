import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { testDb } from "../../../test/helpers/db";

// Storage as on the live site: each photo gets a key in R2, and what's discarded is recorded.
const discarded: string[] = [];
vi.mock("../receipt-store", () => ({
  storeFile: async (prefix: string) => ({ storageKey: `${prefix}/${randomUUID()}`, data: null }),
  discardStoredFiles: async (files: { storageKey: string | null }[]) => {
    for (const f of files) if (f.storageKey) discarded.push(f.storageKey);
  },
}));

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let photos: typeof import("../profile-photos");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  photos = await import("../profile-photos");
});

const png = () => new File([new Uint8Array([1, 2, 3])], "me.png", { type: "image/png" });

describe("profile photos", () => {
  it("delete the old file from storage when replaced or removed", async () => {
    const userId = randomUUID();
    await db.insert(schema.user).values({ id: userId, name: "Sam", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    const rows = () => db.select().from(schema.profilePhotos).where(eq(schema.profilePhotos.userId, userId));

    await photos.setProfilePhoto(userId, png());
    const [first] = await rows();
    await photos.setProfilePhoto(userId, png());
    const [second] = await rows();
    expect(second.id).not.toBe(first.id);
    expect(discarded).toEqual([first.storageKey]);
    expect((await db.select().from(schema.user).where(eq(schema.user.id, userId)))[0].image).toBe(`/account/photo/${second.id}`);

    await photos.removeProfilePhoto(userId);
    expect(await rows()).toEqual([]);
    expect(discarded).toEqual([first.storageKey, second.storageKey]);
  });
});
