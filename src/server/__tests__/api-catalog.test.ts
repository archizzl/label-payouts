import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { newAccount, testDb } from "../../../test/helpers/db";

process.env.APP_ENCRYPTION_KEY ??= "test-key";

// The merch API, answered from here.
const merchItems = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock("../bandcamp-api", async (original) => ({
  ...(await original<typeof import("../bandcamp-api")>()),
  merchDetails: vi.fn(async () => merchItems.items),
}));

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let cat: typeof import("../api-catalog");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  cat = await import("../api-catalog");
});

const creds = { clientId: "x", clientSecret: "y" } as never;
const label = { band_id: 1, name: "My Label", subdomain: "mylabel" };
const bandsOf = async (orgId: string) => db.select().from(schema.bands).where(eq(schema.bands.orgId, orgId));
const releasesOf = async (orgId: string) => db.select().from(schema.releases).where(eq(schema.releases.orgId, orgId));

describe("artists from the API", () => {
  it("adds new artists and links existing bands by name, once", async () => {
    const orgId = await newAccount();
    await db.insert(schema.bands).values({ orgId, name: "The Existing Band" });
    const accounts = [{ ...label, member_bands: [{ band_id: 2, name: "Existing Band", subdomain: "existingband" }, { band_id: 3, name: "New One", subdomain: "newone" }] }];
    expect(await cat.artistsFromApi(orgId, accounts)).toEqual({ added: 1, linked: 1 });
    const bands = await bandsOf(orgId);
    expect(bands.find((b) => b.name === "The Existing Band")?.urlPatterns).toEqual(["existingband"]);
    expect(bands.find((b) => b.name === "New One")?.urlPatterns).toEqual(["newone"]);
    expect(await cat.artistsFromApi(orgId, accounts)).toEqual({ added: 0, linked: 0 });
  });
});

describe("merch and formats from the API", () => {
  it("adds a format to its album, other merch as merch items, and nothing twice", async () => {
    const orgId = await newAccount();
    const [band] = await db.insert(schema.bands).values({ orgId, name: "Artist", urlPatterns: ["artist"] }).returning();
    await db.insert(schema.bands).values({ orgId, name: "My Label", isLabel: true });
    await db.insert(schema.releases).values({ orgId, bandId: band.id, title: "Big Album", kind: "album" });
    merchItems.items = [
      { package_id: 10, album_title: "Big Album", title: "Big Album CD", subdomain: "artist", price: 10, currency: "USD", sku: "CD1" },
      { package_id: 11, album_title: null, title: "Logo Shirt", subdomain: "artist", options: [{ option_id: 1, title: "M", sku: "S-M" }] },
      { package_id: 12, album_title: null, title: "Label Tote", subdomain: "mylabel" },
      { package_id: 13, album_title: "Not Here Yet", title: "Tape", subdomain: "artist" },
      { package_id: 14, album_title: null, title: "Stranger's Shirt", subdomain: "someoneelse" },
    ];
    expect(await cat.merchFromApi(orgId, creds, [label])).toEqual({ formats: 1, merch: 2 });
    const rows = await releasesOf(orgId);
    expect(rows.find((r) => r.title === "Big Album")?.packages.map((p) => p.sku)).toEqual(["CD1"]);
    expect(rows.find((r) => r.title === "Logo Shirt")).toMatchObject({ kind: "merch", bandId: band.id, bandcampId: 11 });
    expect(rows.find((r) => r.title === "Logo Shirt")?.packages[0].options).toEqual([{ title: "M", sku: "S-M" }]);
    expect(rows.find((r) => r.title === "Label Tote")?.kind).toBe("merch");
    expect(rows.some((r) => r.title === "Tape" || r.title === "Stranger's Shirt")).toBe(false);
    expect(await cat.merchFromApi(orgId, creds, [label])).toEqual({ formats: 0, merch: 0 });
    expect(await releasesOf(orgId)).toHaveLength(rows.length);
  });
});

describe("releases from sales", () => {
  it("adds an album that sold but isn't in the catalog, and matches its sales", async () => {
    const orgId = await newAccount();
    const [band] = await db.insert(schema.bands).values({ orgId, name: "Artist", urlPatterns: ["artist"] }).returning();
    const [imp] = await db.insert(schema.imports).values({ orgId, filename: "t", rowCount: 2, addedCount: 2, duplicateCount: 0 }).returning();
    const sale = (n: number, category: "album" | "track", itemUrl: string, itemName: string) => ({
      orgId,
      importId: imp.id,
      bandId: band.id,
      dedupeKey: `k${n}`,
      date: "2026-10-01",
      itemType: category,
      category,
      itemName,
      artist: "Artist",
      itemUrl,
      packageName: "",
      currency: "USD",
      netCents: 800,
      transactionId: `t${n}`,
      routingKey: itemUrl,
      raw: {},
    });
    await db.insert(schema.sales).values([
      sale(1, "album", "https://artist.bandcamp.com/album/new-one", "New One"),
      sale(2, "album", "https://artist.bandcamp.com/album/new-one", "New One"),
      sale(3, "track", "https://artist.bandcamp.com/track/a-song", "A Song"),
    ]);
    expect(await cat.releasesFromSales(orgId)).toEqual({ added: 1 });
    const rows = await releasesOf(orgId);
    expect(rows).toMatchObject([{ title: "New One", kind: "album", bandId: band.id, url: "https://artist.bandcamp.com/album/new-one" }]);
    expect(await cat.releasesFromSales(orgId)).toEqual({ added: 0 });
  });
});
