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
  it("records the merch item picked, and names the sale after it when there's no description", async () => {
    const { band, lp } = await setup();
    expect(await actions.addManualSale(null, form({ bandId: band.id, kind: "merch", item: `${lp.id}:11`, amount: "25.00" }))).toEqual({
      ok: "Added Night Swims, 12in Vinyl LP.",
    });
    expect(await lastSale()).toMatchObject({ releaseId: lp.id, packageName: "12in Vinyl LP", itemName: "Night Swims", category: "merch", netCents: 2500 });
  });

  it("keeps the description given, for a merch item with no formats of its own", async () => {
    const { band, shirt } = await setup();
    await actions.addManualSale(null, form({ bandId: band.id, kind: "merch", item: `${shirt.id}:`, itemName: "Shirt at the Mercury", amount: "20" }));
    expect(await lastSale()).toMatchObject({ releaseId: shirt.id, packageName: "", itemName: "Shirt at the Mercury" });
  });

  it("needs a description without an item, and refuses another band's item", async () => {
    const { band, theirs } = await setup();
    expect(await actions.addManualSale(null, form({ bandId: band.id, kind: "merch", amount: "20" }))).toEqual({ error: "Say what it was." });
    expect(await actions.addManualSale(null, form({ bandId: band.id, kind: "merch", item: `${theirs.id}:`, amount: "20" }))).toEqual({
      error: "That item isn’t the band’s.",
    });
    // An item is only for merch: a show ignores it.
    await actions.addManualSale(null, form({ bandId: band.id, kind: "show", item: `${theirs.id}:`, itemName: "Door money", amount: "300" }));
    expect(await lastSale()).toMatchObject({ releaseId: null, itemName: "Door money", itemType: "show" });
  });
});
