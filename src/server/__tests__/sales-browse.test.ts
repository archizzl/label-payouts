import { inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { newAccount, testDb } from "../../../test/helpers/db";

process.env.APP_ENCRYPTION_KEY ??= "test-key";

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
    expect(all.trends.type).toEqual({
      months: ["2026-01", "2026-02", "2026-03"],
      series: [
        { key: "merch", values: [0, 0, 1800] },
        { key: "album", values: [900, 0, -400] },
        { key: "track", values: [0, 90, 0] },
      ],
    });
    const us = await browse.summarizeSales(orgId, f({ country: "United States" }));
    expect(us.totals[0]).toMatchObject({ sales: 3, net: 1800 });
  });

  it("marks whether each sale's money has been paid out, by the payout covering it", async () => {
    const { orgId, flagDay } = await setup();
    const [person] = await db.insert(schema.people).values({ orgId, name: "Member" }).returning();
    // January for the whole label: everyone paid. February for Flag Day only: not paid yet.
    const [jan] = await db.insert(schema.periods).values({ orgId, name: "Jan", startDate: "2026-01-01", endDate: "2026-01-31" }).returning();
    const [feb] = await db
      .insert(schema.periods)
      .values({ orgId, name: "Feb", startDate: "2026-02-01", endDate: "2026-02-28", bandId: flagDay.id })
      .returning();
    await db.insert(schema.payouts).values([
      { orgId, periodId: jan.id, personId: person.id, currency: "USD", amountCents: 900, byBand: {}, status: "paid" },
      { orgId, periodId: feb.id, personId: person.id, currency: "USD", amountCents: 90, byBand: {}, status: "pending" },
    ]);
    const { rows } = await browse.browseSales(orgId, f({ sort: "date", dir: "asc" }));
    expect(rows.map((r) => [r.itemName, r.payoutState, r.periodId])).toEqual([
      ["LP", "paid", jan.id],
      ["Single", "pending", feb.id],
      ["Shirt", "none", null],
      ["LP refund", "none", null],
      ["Mystery", "none", null],
    ]);
    expect((await browse.browseSales(orgId, f({ payout: "pending" }))).rows.map((r) => r.itemName)).toEqual(["Single"]);
    const summary = await browse.summarizeSales(orgId, f());
    expect(summary.byPayout).toEqual({ paid: { net: 900, sales: 1 }, pending: { net: 90, sales: 1 }, none: { net: 1400, sales: 3 } });
  });

  it("uses a payout's list of sales: a later sale dated inside it isn't marked paid", async () => {
    const { orgId } = await setup();
    const [person] = await db.insert(schema.people).values({ orgId, name: "Member" }).returning();
    const [jan] = await db.insert(schema.periods).values({ orgId, name: "Jan", startDate: "2026-01-01", endDate: "2026-02-28" }).returning();
    await db.insert(schema.periodSales).values({ orgId, periodId: jan.id, dedupeKey: "LP" }); // it paid the LP, not the Single
    await db.insert(schema.payouts).values({ orgId, periodId: jan.id, personId: person.id, currency: "USD", amountCents: 900, byBand: {}, status: "paid" });
    const { rows } = await browse.browseSales(orgId, f({ sort: "date", dir: "asc" }));
    expect(rows.slice(0, 2).map((r) => [r.itemName, r.payoutState])).toEqual([
      ["LP", "paid"],
      ["Single", "none"],
    ]);
  });

  it("finds a buyer's sales by their full email, and links them together", async () => {
    const { orgId } = await setup();
    const { emailFingerprint } = await import("../secrets");
    const ann = emailFingerprint("ann@example.com")!;
    await db.update(schema.sales).set({ buyerKey: ann }).where(inArray(schema.sales.itemName, ["LP", "Shirt"]));
    const names = async (sp: Record<string, string>) => (await browse.browseSales(orgId, f(sp))).rows.map((r) => r.itemName).sort();
    expect(await names({ q: "Ann@Example.com" })).toEqual(["LP", "Shirt"]);
    expect(await names({ q: "example.com" })).toEqual([]); // part of an email can't be matched
    expect(await names({ buyer: ann })).toEqual(["LP", "Shirt"]);
    const lp = (await browse.browseSales(orgId, f({ q: "ann@example.com" }))).rows.find((r) => r.itemName === "LP")!;
    expect(lp).toMatchObject({ buyerSales: 2, fanEmail: null });
    await db.insert(schema.fans).values({ orgId, email: "ann@example.com", name: "Ann", addedOn: "2026-01-01", emailKey: ann });
    expect((await browse.browseSales(orgId, f({ buyer: ann }))).rows[0]).toMatchObject({ fanEmail: "ann@example.com", fanName: "Ann" });
  });

  it("keeps accounts apart", async () => {
    await setup();
    expect((await browse.browseSales(await newAccount(), f())).count).toBe(0);
  });

  it("pages through sales, as many rows at a time as asked", async () => {
    const { orgId } = await setup();
    const page = async (sp: Record<string, string>) => (await browse.browseSales(orgId, f({ sort: "date", dir: "asc", ...sp }))).rows.map((r) => r.itemName);
    expect(await page({ per: "2" })).toHaveLength(5); // under 5 isn't allowed: it becomes 5
    expect(f({ per: "2" }).per).toBe(5);
    expect(f({}).per).toBe(browse.DEFAULT_PAGE_SIZE);
    expect(await page({ per: "5", page: "1" })).toHaveLength(5);
    expect(await page({ per: "5", page: "2" })).toEqual([]);
    expect(browse.filterQuery(f({ per: "50" }), { page: 2 })).toBe("?page=2&per=50");
    expect(browse.filterQuery(f({ per: "10" }), { page: 2 })).toBe("?page=2"); // 10 is the default
  });

  it("builds links that keep the other filters", () => {
    const filter = f({ band: "3", sort: "net", dir: "asc", page: "2" });
    expect(browse.filterQuery(filter, { country: "Canada", page: 1 })).toBe("?band=3&country=Canada&sort=net&dir=asc");
  });
});
