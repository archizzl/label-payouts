import { beforeAll, describe, expect, it } from "vitest";
import { newAccount, testDb } from "../../../test/helpers/db";

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let data: typeof import("../data");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  data = await import("../data");
});

/** An account with two bands, one member each, and three $10 sales. */
async function setup() {
  const orgId = await newAccount();
  const { bands, people, splitRules, splitShares, imports, sales } = schema;
  const [a] = await db.insert(bands).values({ orgId, name: "Band A" }).returning();
  const [b] = await db.insert(bands).values({ orgId, name: "Band B" }).returning();
  for (const band of [a, b]) {
    const [p] = await db.insert(people).values({ orgId, name: `${band.name} member` }).returning();
    const [rule] = await db.insert(splitRules).values({ orgId, scope: "band_default", bandId: band.id }).returning();
    await db.insert(splitShares).values({ orgId, ruleId: rule.id, personId: p.id, bps: 10000 });
  }
  const [imp] = await db.insert(imports).values({ orgId, filename: "t", rowCount: 3, addedCount: 3, duplicateCount: 0 }).returning();
  const sale = async (key: string, bandId: number, date: string) =>
    (
      await db
        .insert(sales)
        .values({
          orgId,
          importId: imp.id,
          dedupeKey: key,
          date,
          itemType: "album",
          category: "album",
          itemName: "x",
          artist: "",
          itemUrl: "",
          packageName: "",
          currency: "USD",
          netCents: 1000,
          transactionId: key,
          routingKey: key,
          bandId,
          raw: {},
        })
        .returning()
    )[0];
  return { orgId, a, b, aJan: await sale("a-jan", a.id, "2026-01-10"), bJan: await sale("b-jan", b.id, "2026-01-12"), aFeb: await sale("a-feb", a.id, "2026-02-05") };
}

describe("paying bands one at a time", () => {
  it("never pays a sale twice across band and whole-label payouts", async () => {
    const { orgId, a, b, aJan, bJan, aFeb } = await setup();
    const { periods } = schema;
    // A preview isn't stored: it's computed for a band and dates (id 0 = not a saved payout).
    const finalize = async (name: string, scope: { startDate: string; endDate: string; bandId: number | null }) =>
      (await db.insert(periods).values({ orgId, name, ...scope, status: "finalized" }).returning())[0];

    // Pay Band A for January on its own.
    const aScope = { startDate: "2026-01-01", endDate: "2026-01-31", bandId: a.id };
    expect((await data.computePayoutPeriod(orgId, { id: 0, ...aScope })).results.map((r) => r.saleId)).toEqual([aJan.id]); // not Band B's sale
    const aPeriod = await finalize("A Jan", aScope);

    // A whole-label payout for Jan–Feb skips what Band A was already paid.
    const allScope = { startDate: "2026-01-01", endDate: "2026-02-28", bandId: null };
    const label = await data.computePayoutPeriod(orgId, { id: 0, ...allScope });
    expect(label.results.map((r) => r.saleId).sort()).toEqual([bJan.id, aFeb.id].sort());
    expect(label.alreadyPaid).toEqual([{ period: expect.objectContaining({ id: aPeriod.id }), sales: 1 }]);
    const all = await finalize("Jan–Feb", allScope);
    // Once finalized, a payout still sees its own sales (it isn't "already paid" by itself).
    expect((await data.computePayoutPeriod(orgId, all)).results).toHaveLength(2);

    // A later Band B payout over January finds nothing left to pay.
    const bOnly = await data.computePayoutPeriod(orgId, { id: 0, startDate: "2026-01-01", endDate: "2026-01-31", bandId: b.id });
    expect(bOnly.results).toEqual([]);
    expect(bOnly.alreadyPaid.map((x) => x.period.id)).toEqual([all.id]);
  });

  it("keeps accounts apart: one account's sales and payouts never show up in another's", async () => {
    const one = await setup();
    const two = await setup();
    const sumOne = await data.computeAllTime(one.orgId);
    expect(sumOne.results.map((r) => r.saleId).sort()).toEqual([one.aJan.id, one.bJan.id, one.aFeb.id].sort());
    // A finalized payout in account two doesn't mark account one's sales as paid.
    await db.insert(schema.periods).values({ orgId: two.orgId, name: "All", startDate: "2000-01-01", endDate: "2099-01-01", bandId: null });
    expect((await data.computePayoutPeriod(one.orgId, { id: 0, startDate: "2026-01-01", endDate: "2026-12-31", bandId: null })).results).toHaveLength(3);
    const names = await data.nameMaps(two.orgId);
    expect([...names.band.keys()].sort()).toEqual([two.a.id, two.b.id].sort());
  });
});

describe("payouts remember exactly which sales they paid", () => {
  /** Like finalizing in the app: work out the payout, save it, and save the list of sales it paid. */
  async function finalize(orgId: string, scope: { startDate: string; endDate: string; bandId: number | null }) {
    const { results, saleById } = await data.computePayoutPeriod(orgId, { id: 0, ...scope });
    const [p] = await db.insert(schema.periods).values({ orgId, name: "p", ...scope, status: "finalized" }).returning();
    await db.insert(schema.periodSales).values(results.map((r) => ({ orgId, periodId: p.id, dedupeKey: saleById.get(r.saleId)!.dedupeKey })));
    return p;
  }
  const addSale = async (orgId: string, importId: number, key: string, bandId: number, date: string) =>
    db.insert(schema.sales).values({
      orgId, importId, dedupeKey: key, date, itemType: "album", category: "album", itemName: "x", artist: "", itemUrl: "",
      packageName: "", currency: "USD", netCents: 1000, transactionId: key, routingKey: key, bandId, raw: {},
    });
  const keys = async (orgId: string, scope: { startDate: string; endDate: string; bandId: number | null; id?: number }) => {
    const { results, saleById } = await data.computePayoutPeriod(orgId, { id: 0, ...scope });
    return results.map((r) => saleById.get(r.saleId)!.dedupeKey).sort();
  };

  it("pays a sale made later on a payout's last day in the next payout, which starts that day", async () => {
    const { orgId, a, aJan } = await setup();
    const jan = await finalize(orgId, { startDate: "2026-01-01", endDate: "2026-01-10", bandId: a.id });
    // Later on Jan 10, after finalizing, another sale comes in.
    await addSale(orgId, aJan.importId, "a-jan-late", a.id, "2026-01-10");
    expect(await keys(orgId, { startDate: "2026-01-10", endDate: "2026-02-28", bandId: a.id })).toEqual(["a-feb", "a-jan-late"]);
    // The finalized payout still has just what it paid.
    expect(await keys(orgId, { id: jan.id, startDate: "2026-01-01", endDate: "2026-01-10", bandId: a.id })).toEqual(["a-jan"]);
  });

  it("keeps a sale paid when it's deleted and imported again", async () => {
    const { orgId, a, aJan } = await setup();
    await finalize(orgId, { startDate: "2026-01-01", endDate: "2026-01-31", bandId: a.id });
    const { eq } = await import("drizzle-orm");
    await db.delete(schema.sales).where(eq(schema.sales.id, aJan.id));
    await addSale(orgId, aJan.importId, "a-jan", a.id, "2026-01-10");
    expect(await keys(orgId, { startDate: "2026-01-01", endDate: "2026-02-28", bandId: a.id })).toEqual(["a-feb"]);
  });

  it("still treats payouts without a list (older books) as covering their dates", async () => {
    const { orgId, a } = await setup();
    await db.insert(schema.periods).values({ orgId, name: "old", startDate: "2026-01-01", endDate: "2026-01-31", bandId: a.id, status: "finalized" });
    expect(await keys(orgId, { startDate: "2026-01-01", endDate: "2026-02-28", bandId: a.id })).toEqual(["a-feb"]);
  });
});
