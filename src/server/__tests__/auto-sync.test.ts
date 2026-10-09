import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { newAccount, testDb } from "../../../test/helpers/db";

process.env.APP_ENCRYPTION_KEY ??= "test-key";

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let sync: typeof import("../auto-sync");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  sync = await import("../auto-sync");
});
afterEach(() => vi.unstubAllGlobals());

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
const settings = async (orgId: string) => (await db.select().from(schema.accountSettings).where(eq(schema.accountSettings.orgId, orgId)))[0];

async function account(values: Partial<typeof schema.accountSettings.$inferInsert> = {}) {
  const orgId = await newAccount();
  await db.insert(schema.accountSettings).values({ orgId, bandcampUrl: "mylabel.bandcamp.com", ...values });
  return orgId;
}

describe("syncing on open, at most once an hour", () => {
  it("runs the first time, then not again within the hour", async () => {
    const orgId = await account();
    expect(await sync.claimSync(orgId, false)).toBe(true);
    await db.update(schema.accountSettings).set({ syncFinishedAt: new Date().toISOString() }).where(eq(schema.accountSettings.orgId, orgId));
    expect(await sync.claimSync(orgId, false)).toBe(false);
    expect((await sync.syncStatus(orgId))?.due).toBe(false);
  });

  it("runs again once the last sync is over an hour old", async () => {
    const orgId = await account({ syncStartedAt: hoursAgo(2), syncFinishedAt: hoursAgo(1.9) });
    expect((await sync.syncStatus(orgId))?.due).toBe(true);
    expect(await sync.claimSync(orgId, false)).toBe(true);
  });

  it("“Sync now” skips the hourly limit, but never starts a second sync alongside a running one", async () => {
    const orgId = await account({ syncStartedAt: hoursAgo(0.1), syncFinishedAt: hoursAgo(0.09) });
    expect(await sync.claimSync(orgId, false)).toBe(false);
    expect(await sync.claimSync(orgId, true)).toBe(true); // now running
    expect(await sync.claimSync(orgId, true)).toBe(false);
    expect((await sync.syncStatus(orgId))?.running).toBe(true);
  });

  it("gives up on a sync that never finished", async () => {
    const orgId = await account({ syncStartedAt: hoursAgo(0.5) });
    expect((await sync.syncStatus(orgId))?.running).toBe(false);
    expect(await sync.claimSync(orgId, true)).toBe(true);
  });

  it("does nothing for an account with no Bandcamp set up", async () => {
    const orgId = await account({ bandcampUrl: null });
    const result = await sync.syncAccount(orgId);
    expect(result.ran).toBe(false);
    expect((await settings(orgId)).syncStartedAt).toBeNull();
    expect((await sync.syncStatus(orgId))?.due).toBe(false);
  });

  it("records what went wrong when Bandcamp can't be reached, and still finishes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const orgId = await account();
    const result = await sync.syncAccount(orgId);
    expect(result.ran).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
    const s = await settings(orgId);
    expect(s.syncFinishedAt! >= s.syncStartedAt!).toBe(true);
    expect(s.syncError).toBeTruthy();
    expect((await sync.syncAccount(orgId)).ran).toBe(false); // not again within the hour
  });
});

describe("when Bandcamp shows a bot check instead of its pages", () => {
  it("isn't an error, and isn't mentioned", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html><head><title>Client Challenge</title></head><body></body></html>", { status: 200 })),
    );
    const orgId = await account();
    const result = await sync.syncAccount(orgId, { force: true });
    expect(result.errors).toEqual([]);
    expect(result.summary).toBe("Up to date.");
    expect((await settings(orgId)).syncError).toBeNull();
  });
});

describe("the catalog sync (npm run sync-catalog)", () => {
  it("records when it last read the pages, without holding up the hourly sync", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html><title>Artists</title></html>", { status: 200 })));
    const orgId = await account();
    await sync.syncCatalog(orgId);
    const s = await settings(orgId);
    expect(s.catalogSyncedAt).toBeTruthy();
    expect(s.syncStartedAt).toBeNull();
    expect((await sync.syncStatus(orgId))?.due).toBe(true);
  });

  it("doesn't record a sync when Bandcamp shows a bot check", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<title>Client Challenge</title>", { status: 200 })));
    const orgId = await account();
    const r = await sync.syncCatalog(orgId);
    expect(r.errors.join(" ")).toContain("bot check");
    expect((await settings(orgId)).catalogSyncedAt).toBeNull();
  });
});

describe("artists' photos", () => {
  it("replaces a photo that no longer loads, and fills in a missing one, from the artist's page", async () => {
    const { refreshBandPhotos } = await import("../sync");
    const orgId = await account();
    await db.insert(schema.bands).values([
      { orgId, name: "Changed", urlPatterns: ["changed"], imageUrl: "https://f4.bcbits.com/img/0000000001_36.jpg" },
      { orgId, name: "Missing", urlPatterns: ["missing"] },
      { orgId, name: "Fine", urlPatterns: ["fine"], imageUrl: "https://f4.bcbits.com/img/0000000003_36.jpg" },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("0000000001_36.jpg")) return new Response(null, { status: 404 });
        if (url.includes("bcbits")) return new Response(null, { status: 200 });
        return new Response('<img class="band-photo" src="https://f4.bcbits.com/img/0000000099_21.jpg">', { status: 200 });
      }),
    );
    expect(await refreshBandPhotos(orgId)).toBe(2);
    const photos = Object.fromEntries((await db.select().from(schema.bands).where(eq(schema.bands.orgId, orgId))).map((b) => [b.name, b.imageUrl]));
    expect(photos).toEqual({
      Changed: "https://f4.bcbits.com/img/0000000099_36.jpg",
      Missing: "https://f4.bcbits.com/img/0000000099_36.jpg",
      Fine: "https://f4.bcbits.com/img/0000000003_36.jpg",
    });
  });
});
