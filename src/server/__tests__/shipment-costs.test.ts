import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { newAccount, testDb } from "../../../test/helpers/db";
import type { MerchOrder } from "@/lib/merch-orders";

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let costs: typeof import("../shipment-costs");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  costs = await import("../shipment-costs");
});

const order = (bandIds: number[]): MerchOrder => ({
  paymentId: 1,
  date: "2026-10-02",
  daysWaiting: 4,
  buyer: { name: "Ann", email: null, phone: null },
  note: null,
  address: [],
  country: "US",
  lines: [{ saleItemId: 1, name: "Flags of the World", option: null, quantity: 2, sku: null, artist: "Flag Day", bandId: bandIds[0] ?? null }],
  total: 29,
  currency: "USD",
  preorderUntil: null,
  failed: false,
  bandIds,
});
const form = (fields: Record<string, string | File>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
};

describe("shipping costs on a shipped order", () => {
  it("does nothing when no costs are entered, and wants an amount with a receipt", async () => {
    const orgId = await newAccount();
    expect(await costs.readShipmentCosts(orgId, form({ postage: "", packaging: "" }), order([]))).toBeNull();
    const pdf = new File(["%PDF"], "label.pdf", { type: "application/pdf" });
    await expect(costs.readShipmentCosts(orgId, form({ receipt: pdf }), order([]))).rejects.toThrow(/what the postage/);
  });

  it("records postage and packaging as approved receipts for the order's band, with the receipt file", async () => {
    const orgId = await newAccount();
    const [band] = await db.insert(schema.bands).values({ orgId, name: "Flag Day" }).returning();
    const [person] = await db.insert(schema.people).values({ orgId, name: "Henry" }).returning();
    const o = order([band.id]);
    const pdf = new File(["%PDF"], "label.pdf", { type: "application/pdf" });
    const read = await costs.readShipmentCosts(orgId, form({ postage: "4.63", packaging: "0.85", costPaidBy: `person:${person.id}`, receipt: pdf }), o);
    const total = await costs.recordShipmentCosts(orgId, null, o, read!, "USPS");
    expect(total).toBe(548);
    const rows = await db.select().from(schema.expenses).where(eq(schema.expenses.orgId, orgId));
    expect(rows.map((r) => [r.category, r.amountCents, r.bandId, r.paidBy, r.paidByPersonId, r.status, r.vendor])).toEqual([
      ["Shipping", 463, band.id, "person", person.id, "approved", "USPS"],
      ["Packaging", 85, band.id, "person", person.id, "approved", null],
    ]);
    expect(rows[0].description).toBe("Postage for Ann: 2 × Flags of the World");
    const files = await db.select().from(schema.expenseFiles).where(eq(schema.expenseFiles.orgId, orgId));
    expect(files.map((f) => [f.expenseId, f.filename])).toEqual([[rows[0].id, "label.pdf"]]);
  });

  it("won't charge a band fund for an order spanning several bands, or a person from another account", async () => {
    const orgId = await newAccount();
    await expect(costs.readShipmentCosts(orgId, form({ postage: "3", costPaidBy: "band_fund" }), order([1, 2]))).rejects.toThrow(/single band/);
    const [stranger] = await db.insert(schema.people).values({ orgId: await newAccount(), name: "X" }).returning();
    await expect(costs.readShipmentCosts(orgId, form({ postage: "3", costPaidBy: `person:${stranger.id}` }), order([]))).rejects.toThrow(/isn’t part/);
  });
});
