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
