import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { newAccount, testDb } from "../../../test/helpers/db";

let orgId = "";
let testUser = "";
let managedBy: { labelOrgId: string; bandId: number } | null = null;
vi.mock("../context", () => ({
  requireAccess: async () => ({ orgId, managedBy, access: { admin: true, permissions: {}, bandAreas: [], bandIds: [] }, user: { id: testUser, name: "Tester" } }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let actions: typeof import("../manual-sale-actions");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  testUser = randomUUID();
  await db.insert(schema.user).values({ id: testUser, name: "Tester", email: `${testUser}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  actions = await import("../manual-sale-actions");
});

const pkg = (bandcampId: number, title: string) => ({ bandcampId, title, typeName: null, sku: null, upc: null, price: null, currency: null });

async function setup() {
  managedBy = null;
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

  it("for a band account the label made, lists and takes the label's merch for its band, sold out or not, and stock outside the catalog", async () => {
    // The label: the band's CDs in its catalog (one out of stock), and a tote in stock that isn't in the catalog.
    const labelOrgId = await newAccount("Label");
    const [labelBand] = await db.insert(schema.bands).values({ orgId: labelOrgId, name: "Flag Day" }).returning();
    const [otherBand] = await db.insert(schema.bands).values({ orgId: labelOrgId, name: "Someone Else" }).returning();
    const [cd] = await db
      .insert(schema.releases)
      .values({ orgId: labelOrgId, bandId: labelBand.id, title: "Flags of the World", kind: "album", packages: [pkg(31, "CD")] })
      .returning();
    await db.insert(schema.releases).values({ orgId: labelOrgId, bandId: otherBand.id, title: "Not Theirs", kind: "album", packages: [pkg(41, "LP")] });
    // In person, the CD sells for $12 (on Bandcamp it has no price here), and the tote for $15.
    await db
      .insert(schema.inventoryItems)
      .values({ orgId: labelOrgId, bandId: labelBand.id, name: "Flags of the World — CD", releaseId: cd.id, packageId: 31, onHand: 0, priceCents: 1200 });
    const [tote] = await db.insert(schema.inventoryItems).values({ orgId: labelOrgId, bandId: labelBand.id, name: "Tote bag", onHand: 4, priceCents: 1500 }).returning();
    // The band's own books: its band, and nothing in its catalog.
    orgId = await newAccount("Flag Day", "band");
    const [band] = await db.insert(schema.bands).values({ orgId, name: "Flag Day" }).returning();
    managedBy = { labelOrgId, bandId: labelBand.id };

    const { merchChoices, merchSources } = await import("../manual-sales");
    const choices = merchChoices(await merchSources({ orgId, managed: managedBy }));
    expect(choices.map((c) => [c.label, c.price])).toEqual([
      ["Flags of the World — CD", 12],
      ["Tote bag", 15],
    ]);

    const result = await actions.addManualSale(
      null,
      form({ bandId: band.id, kind: "merch", [`each:${cd.id}:31`]: "10", [`sold:${cd.id}:31`]: 2, [`each:stock:${tote.id}`]: "15", [`sold:stock:${tote.id}`]: 1 }),
    );
    expect(result).toEqual({ ok: "Added 2 sales." });
    const sales = await db.select().from(schema.sales).where(eq(schema.sales.orgId, orgId)).orderBy(schema.sales.id);
    expect(sales.map((s) => ({ itemName: s.itemName, packageName: s.packageName, releaseId: s.releaseId, netCents: s.netCents, bandId: s.bandId }))).toEqual([
      { itemName: "Flags of the World", packageName: "CD", releaseId: null, netCents: 2000, bandId: band.id },
      { itemName: "Tote bag", packageName: "", releaseId: null, netCents: 1500, bandId: band.id },
    ]);
  });

  it("names a format without repeating the release", async () => {
    const { merchName } = await import("../manual-sales");
    expect(merchName({ title: "Triple Single" }, { title: "Triple Single CD" })).toEqual({ itemName: "Triple Single", format: "CD" });
    expect(merchName({ title: "Night Swims" }, { title: "12in Vinyl LP" })).toEqual({ itemName: "Night Swims", format: "12in Vinyl LP" });
    expect(merchName({ title: "Logo T-Shirt" }, { title: "Logo T-Shirt" })).toEqual({ itemName: "Logo T-Shirt", format: "" });
  });

  it("takes what's sold off its stock (each size its own line), and puts it back when the sale is deleted", async () => {
    const { band, shirt } = await setup();
    const [small, medium] = await db
      .insert(schema.inventoryItems)
      .values([
        { orgId, bandId: band.id, name: "Logo T-Shirt", releaseId: shirt.id, option: "S", onHand: 5, priceCents: 2000 },
        { orgId, bandId: band.id, name: "Logo T-Shirt", releaseId: shirt.id, option: "M", onHand: 0 },
      ])
      .returning();
    const [sticker] = await db.insert(schema.inventoryItems).values({ orgId, bandId: band.id, name: "Sticker", onHand: 10, priceCents: 300 }).returning();
    const { merchChoices, merchSources } = await import("../manual-sales");
    const choices = merchChoices(await merchSources({ orgId, managed: null }));
    expect(choices.filter((c) => c.value.startsWith("stock:")).map((c) => [c.label, c.price])).toEqual([
      ["Logo T-Shirt — M", null],
      ["Logo T-Shirt — S", 20],
      ["Sticker", 3],
    ]);

    const onHand = async (id: number) => (await db.select().from(schema.inventoryItems).where(eq(schema.inventoryItems.id, id)))[0].onHand;
    await actions.addManualSale(
      null,
      form({ bandId: band.id, kind: "merch", [`each:stock:${small.id}`]: "20", [`sold:stock:${small.id}`]: 2, [`each:stock:${sticker.id}`]: "3", [`sold:stock:${sticker.id}`]: 3, [`each:stock:${medium.id}`]: "20", [`sold:stock:${medium.id}`]: 1 }),
    );
    expect([await onHand(small.id), await onHand(sticker.id), await onHand(medium.id)]).toEqual([3, 7, 0]);
    const sales = await db.select().from(schema.sales).where(eq(schema.sales.orgId, orgId));
    expect(sales.find((x) => x.itemName === "Logo T-Shirt")).toMatchObject({ packageName: "S", releaseId: shirt.id, netCents: 4000 });

    // The sticker sale goes: its 3 are back. (M was out of stock: nothing came off, nothing goes back.)
    const stickerSale = sales.find((x) => x.itemName === "Sticker")!;
    const fd = new FormData();
    fd.set("id", String(stickerSale.id));
    expect(await actions.deleteManualSale(null, fd)).toEqual({ ok: "Deleted." });
    expect([await onHand(small.id), await onHand(sticker.id), await onHand(medium.id)]).toEqual([3, 10, 0]);
    const history = await db.select().from(schema.inventoryMoves).where(eq(schema.inventoryMoves.itemId, sticker.id)).orderBy(schema.inventoryMoves.id);
    expect(history.map((m) => [m.reason, m.delta])).toEqual([
      ["sold", -3],
      ["other", 3],
    ]);
  });
});
