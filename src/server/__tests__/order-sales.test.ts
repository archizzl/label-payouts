import { beforeAll, describe, expect, it } from "vitest";
import type { MerchOrder } from "@/lib/merch-orders";
import { newAccount, testDb } from "../../../test/helpers/db";

process.env.APP_ENCRYPTION_KEY ??= "test-key";

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let orders: typeof import("../merch-orders");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  orders = await import("../merch-orders");
});

const order = (paymentId: number, itemIds: number[]): MerchOrder => ({
  paymentId,
  paymentState: "paid",
  date: "2026-10-07",
  daysWaiting: 2,
  buyer: { name: "Fan", email: null, phone: null },
  note: null,
  address: [],
  country: "",
  lines: itemIds.map((saleItemId) => ({ saleItemId, name: "CD", option: null, quantity: 1, sku: null, artist: "", bandId: null })),
  total: 25.46,
  currency: "USD",
  preorderUntil: null,
  failed: false,
  bandIds: [],
});

describe("the sales behind an order", () => {
  it("are found by Bandcamp's transaction id or transaction item id, and only this account's", async () => {
    const orgId = await newAccount();
    const other = await newAccount("Other");
    const imp = async (o: string) => (await db.insert(schema.imports).values({ orgId: o, filename: "t", rowCount: 1, addedCount: 1, duplicateCount: 0 }).returning())[0];
    const [i1, i2] = [await imp(orgId), await imp(other)];
    const sale = (o: string, importId: number, key: string, transactionId: string, itemId: string) => ({
      orgId: o, importId, dedupeKey: key, date: "2026-10-07", itemType: "package", category: "merch" as const, itemName: key, artist: "", itemUrl: "",
      packageName: "CD", currency: "USD", netCents: 1722, transactionId, routingKey: key, raw: { "bandcamp transaction item id": itemId, "net amount": "17.22" },
    });
    await db.insert(schema.sales).values([
      sale(orgId, i1.id, "by payment", "1001", "1"),
      sale(orgId, i1.id, "by item", "something-else", "2002"),
      sale(orgId, i1.id, "unrelated", "9999", "9"),
      sale(other, i2.id, "other account", "1001", "1"),
    ]);
    const found = await orders.salesForOrders(orgId, [order(1001, [55]), order(3003, [2002]), order(4004, [77])]);
    expect(found.get(1001)?.map((s) => s.itemName)).toEqual(["by payment"]);
    expect(found.get(3003)?.map((s) => s.itemName)).toEqual(["by item"]);
    expect(found.has(4004)).toBe(false);
  });
});
