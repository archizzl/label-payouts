import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { newAccount, testDb } from "../../../test/helpers/db";
import type { Access } from "@/lib/permissions";
import type { Context } from "../context";

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let badges: typeof import("../nav-badges");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  badges = await import("../nav-badges");
});

const admin: Access = { admin: true, permissions: {}, bandAreas: [], bandIds: [] };

async function setup() {
  const orgId = await newAccount();
  const userId = randomUUID();
  await db.insert(schema.user).values({ id: userId, name: "U", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  // With Bandcamp API access, where the saved count of orders to ship comes from.
  await db
    .insert(schema.accountSettings)
    .values({ orgId, bandcampClientId: "id", bandcampClientSecret: "secret", openOrders: { ready: 3, byBand: { "1": 2, "2": 1 }, at: "x" } });
  await db.insert(schema.pickupOrders).values([
    { orgId, paymentId: 1, buyerName: "A", orderDate: "2026-10-01", items: [], bandIds: [1] },
    { orgId, paymentId: 2, buyerName: "B", orderDate: "2026-10-01", items: [], bandIds: [2] },
  ]);
  await db.insert(schema.expenses).values([
    { orgId, date: "2026-10-01", description: "pending", amountCents: 100, paidBy: "label", status: "pending" },
    { orgId, date: "2026-10-01", description: "done", amountCents: 100, paidBy: "label", status: "approved" },
  ]);
  const ctx = (access: Access) => ({ orgId, user: { id: userId, name: "U", email: "u@example.test" }, access }) as unknown as Context;
  return { orgId, userId, ctx };
}

describe("numbers on the header's tabs", () => {
  it("orders to ship plus pickups, receipts to approve; no sales number before Sales has been opened", async () => {
    const { ctx } = await setup();
    expect(await badges.navBadges(ctx(admin))).toEqual({ orders: 5, receipts: 1 });
  });

  it("counts only a band-limited member's bands, and shows receipts only to approvers", async () => {
    const { ctx } = await setup();
    const manager: Access = { admin: false, permissions: { orders: "edit", receipts: "view" }, bandAreas: ["orders"], bandIds: [1] };
    expect(await badges.navBadges(ctx(manager))).toEqual({ orders: 3 });
  });

  it("doesn't count saved Bandcamp orders without API access, only pickups", async () => {
    const { orgId, ctx } = await setup();
    await db.update(schema.accountSettings).set({ bandcampClientId: null, bandcampClientSecret: null }).where(eq(schema.accountSettings.orgId, orgId));
    expect((await badges.navBadges(ctx(admin))).orders).toBe(2);
  });

  it("counts sales imported since Sales was last opened", async () => {
    const { orgId, userId, ctx } = await setup();
    await badges.markSeen(ctx(admin), "sales");
    await db.update(schema.navSeen).set({ seenAt: "2026-10-01 00:00:00" }).where(eq(schema.navSeen.userId, userId));
    const imp = async (at: string) => (await db.insert(schema.imports).values({ orgId, filename: at, rowCount: 1, addedCount: 1, duplicateCount: 0, importedAt: at }).returning())[0].id;
    const sale = (importId: number, key: string) => ({ orgId, importId, dedupeKey: key, date: "2026-10-01", itemType: "album", category: "album" as const, itemName: key, artist: "", itemUrl: "", packageName: "", currency: "USD", netCents: 100, transactionId: key, routingKey: key, raw: {} });
    const old = await imp("2026-09-30 12:00:00");
    const fresh = await imp("2026-10-02 12:00:00");
    await db.insert(schema.sales).values([sale(old, "old"), sale(fresh, "new 1"), sale(fresh, "new 2")]);
    expect((await badges.navBadges(ctx(admin))).sales).toBe(2);
    await badges.markSeen(ctx(admin), "sales");
    expect((await badges.navBadges(ctx(admin))).sales).toBeUndefined();
  });
});
