import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { newAccount, testDb } from "../../../test/helpers/db";

let orgId = "";
vi.mock("../context", () => ({
  requireAccess: async () => ({ orgId, access: { admin: true, permissions: {}, bandAreas: [], bandIds: [] }, user: { name: "Tester" } }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let actions: typeof import("../manual-sale-actions");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  actions = await import("../manual-sale-actions");
});

const pkg = (bandcampId: number, title: string) => ({ bandcampId, title, typeName: null, sku: null, upc: null, price: null, currency: null });

async function setup() {
  orgId = await newAccount("Band", "band");
  const [band] = await db.insert(schema.bands).values({ orgId, name: "Glass Harbor" }).returning();
  const [other] = await db.insert(schema.bands).values({ orgId, name: "Someone Else" }).returning();
  const [lp] = await db
    .insert(schema.releases)
    .values({ orgId, bandId: band.id, title: "Night Swims", kind: "album", packages: [pkg(11, "12in Vinyl LP")] })
    .returning();
  const [shirt] = await db.insert(schema.releases).values({ orgId, bandId: band.id, title: "Logo T-Shirt", kind: "merch" }).returning();
  const [theirs] = await db.insert(schema.releases).values({ orgId, bandId: other.id, title: "Their Tote", kind: "merch" }).returning();
  return { band, lp, shirt, theirs };
}

const form = (values: Record<string, string | number>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ date: "2026-10-17", currency: "USD", quantity: 1, ...values })) fd.set(k, String(v));
  return fd;
};
const lastSale = async () => (await db.select().from(schema.sales).where(eq(schema.sales.orgId, orgId)).orderBy(schema.sales.id)).at(-1)!;

describe("adding a sale by hand", () => {
  it("adds a sale for each merch item sold, at its price each, named like Bandcamp's rows", async () => {
    const { band, lp, shirt } = await setup();
    const result = await actions.addManualSale(
      null,
      form({ bandId: band.id, kind: "merch", [`each:${lp.id}:11`]: "25.00", [`sold:${lp.id}:11`]: 2, [`each:${shirt.id}:`]: "20", [`sold:${shirt.id}:`]: 3 }),
    );
    expect(result).toEqual({ ok: "Added 2 sales." });
    const sales = await db.select().from(schema.sales).where(eq(schema.sales.orgId, orgId)).orderBy(schema.sales.id);
    expect(sales.map((s) => ({ itemName: s.itemName, packageName: s.packageName, releaseId: s.releaseId, quantity: s.quantity, netCents: s.netCents, category: s.category }))).toEqual([
      { itemName: "Night Swims", packageName: "12in Vinyl LP", releaseId: lp.id, quantity: 2, netCents: 5000, category: "merch" },
      { itemName: "Logo T-Shirt", packageName: "", releaseId: shirt.id, quantity: 3, netCents: 6000, category: "merch" },
    ]);
  });

  it("takes something not in the catalog, and leaves out items none were sold of", async () => {
    const { band, lp } = await setup();
    const result = await actions.addManualSale(
      null,
      form({ bandId: band.id, kind: "merch", [`each:${lp.id}:11`]: "25.00", [`sold:${lp.id}:11`]: "", "name:other": "Tote bag", "each:other": "15", "sold:other": 1 }),
    );
    expect(result).toEqual({ ok: "Added Tote bag." });
    expect(await lastSale()).toMatchObject({ itemName: "Tote bag", releaseId: null, netCents: 1500, quantity: 1 });
  });

  it("needs something sold, a price for it, and the band's own items", async () => {
    const { band, shirt, theirs } = await setup();
    expect(await actions.addManualSale(null, form({ bandId: band.id, kind: "merch" }))).toEqual({ error: "Enter how many of something were sold." });
    expect(await actions.addManualSale(null, form({ bandId: band.id, kind: "merch", [`sold:${shirt.id}:`]: 1 }))).toEqual({ error: "Enter the price of Logo T-Shirt." });
    expect(await actions.addManualSale(null, form({ bandId: band.id, kind: "merch", [`each:${theirs.id}:`]: "9", [`sold:${theirs.id}:`]: 1 }))).toEqual({
      error: "That item isn’t the band’s.",
    });
  });

  it("adds a show as one amount", async () => {
    const { band } = await setup();
    await actions.addManualSale(null, form({ bandId: band.id, kind: "show", itemName: "Door money", amount: "300" }));
    expect(await lastSale()).toMatchObject({ releaseId: null, itemName: "Door money", itemType: "show", netCents: 30000, quantity: 1 });
  });
});
