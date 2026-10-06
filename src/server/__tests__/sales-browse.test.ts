import { beforeAll, describe, expect, it } from "vitest";
import { newAccount, testDb } from "../../../test/helpers/db";

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let browse: typeof import("../sales-browse");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  browse = await import("../sales-browse");
});

async function setup() {
  const orgId = await newAccount();
  const [flagDay] = await db.insert(schema.bands).values({ orgId, name: "Flag Day" }).returning();
  const [imp] = await db.insert(schema.imports).values({ orgId, filename: "t", rowCount: 5, addedCount: 5, duplicateCount: 0 }).returning();
  const sale = (key: string, date: string, category: "album" | "track" | "merch", netCents: number, raw: Record<string, string>, bandId: number | null = flagDay.id) =>
    db.insert(schema.sales).values({
      orgId, importId: imp.id, dedupeKey: key, date, itemType: category, category, itemName: key, artist: "Flag Day", itemUrl: "",
      packageName: "", currency: "USD", netCents, transactionId: key, routingKey: key, bandId, raw,
    });
  await sale("LP", "2026-01-10", "album", 900, { country: "United States", referer: "bandcamp" });
  await sale("Single", "2026-02-10", "track", 90, { country: "Canada" });
  await sale("Shirt", "2026-03-10", "merch", 1800, { country: "United States", referer: "instagram.com" });
  await sale("LP refund", "2026-03-11", "album", -900, { country: "United States" });
  await sale("Mystery", "2026-03-12", "album", 500, {}, null);
  return { orgId, flagDay };
}
const f = (sp: Record<string, string> = {}) => browse.parseSalesFilter(sp);

describe("browsing sales", () => {
  it("filters by band, type, country, source, dates, search and refunds", async () => {
    const { orgId, flagDay } = await setup();
    const names = async (sp: Record<string, string>) => (await browse.browseSales(orgId, f(sp))).rows.map((r) => r.itemName).sort();
    expect(await names({})).toHaveLength(5);
    expect(await names({ band: String(flagDay.id) })).toHaveLength(4);
    expect(await names({ band: "none" })).toEqual(["Mystery"]);
    expect(await names({ type: "merch" })).toEqual(["Shirt"]);
    expect(await names({ country: "Canada" })).toEqual(["Single"]);
    expect(await names({ country: "(none)" })).toEqual(["Mystery"]);
    expect(await names({ source: "instagram.com" })).toEqual(["Shirt"]);
    expect(await names({ from: "2026-02-01", to: "2026-03-10" })).toEqual(["Shirt", "Single"]);
    expect(await names({ q: "lp" })).toEqual(["LP", "LP refund"]);
    expect(await names({ refunds: "1" })).toEqual(["LP refund"]);
    expect(await names({ q: "100%" })).toEqual([]);
  });

  it("sorts by any column, both ways", async () => {
    const { orgId } = await setup();
    const order = async (sort: string, dir: string) => (await browse.browseSales(orgId, f({ sort, dir }))).rows.map((r) => r.itemName);
    expect(await order("net", "desc")).toEqual(["Shirt", "LP", "Mystery", "Single", "LP refund"]);
    expect(await order("net", "asc")).toEqual(["LP refund", "Single", "Mystery", "LP", "Shirt"]);
    expect((await order("date", "desc"))[0]).toBe("Mystery");
    expect((await order("item", "asc"))[0]).toBe("LP");
  });

  it("totals and breaks down exactly what's filtered", async () => {
    const { orgId } = await setup();
    const all = await browse.summarizeSales(orgId, f());
    expect(all.totals[0]).toMatchObject({ currency: "USD", sales: 5, net: 2390, refunds: 1, refundCents: -900, units: 3 });
    expect(all.byMonth.map((m) => m.month)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(all.byCountry[0]).toEqual({ key: "United States", net: 1800, units: 1 });
    const us = await browse.summarizeSales(orgId, f({ country: "United States" }));
    expect(us.totals[0]).toMatchObject({ sales: 3, net: 1800 });
  });

  it("keeps accounts apart", async () => {
    await setup();
    expect((await browse.browseSales(await newAccount(), f())).count).toBe(0);
  });

  it("builds links that keep the other filters", () => {
    const filter = f({ band: "3", sort: "net", dir: "asc", page: "2" });
    expect(browse.filterQuery(filter, { country: "Canada", page: 1 })).toBe("?band=3&country=Canada&sort=net&dir=asc");
  });
});
