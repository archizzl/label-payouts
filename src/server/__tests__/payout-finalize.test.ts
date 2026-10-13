import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { newAccount, testDb } from "../../../test/helpers/db";

let orgId = "";
vi.mock("../context", () => ({ requireAccess: async () => ({ orgId }), requireAdmin: async () => ({ orgId }), getContext: async () => ({ orgId }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("redirect"), { to });
  },
}));

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let data: typeof import("../data");
let actions: typeof import("../actions");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  data = await import("../data");
  actions = await import("../actions");
});

/** Band A has a split; Band B doesn't yet. One $10 sale each. */
async function setup() {
  orgId = await newAccount();
  const { bands, people, splitRules, splitShares, imports, sales } = schema;
  const [a] = await db.insert(bands).values({ orgId, name: "Band A" }).returning();
  const [b] = await db.insert(bands).values({ orgId, name: "Band B" }).returning();
  const [p] = await db.insert(people).values({ orgId, name: "A member" }).returning();
  const [rule] = await db.insert(splitRules).values({ orgId, scope: "band_default", bandId: a.id }).returning();
  await db.insert(splitShares).values({ orgId, ruleId: rule.id, personId: p.id, bps: 10000 });
  const [imp] = await db.insert(imports).values({ orgId, filename: "t", rowCount: 2, addedCount: 2, duplicateCount: 0 }).returning();
  for (const [key, bandId] of [
    ["a-1", a.id],
    ["b-1", b.id],
  ] as const) {
    await db.insert(sales).values({
      orgId,
      importId: imp.id,
      dedupeKey: key,
      date: "2026-01-10",
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
    });
  }
  return { a, b, p };
}

const form = (values: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
};

const finalize = async (values: Record<string, string>) => {
  try {
    return await actions.finalizePayout(null, form(values));
  } catch (e) {
    return { redirected: (e as { to?: string }).to };
  }
};

describe("finalizing a payout", () => {
  it("refuses without 'pay the rest now' while some sales can't be paid", async () => {
    await setup();
    const r = await finalize({ startDate: "2026-01-01", endDate: "2026-01-31" });
    expect(r).toMatchObject({ error: expect.stringContaining("1 sale can't be paid") });
  });

  it("pays what it can, and leaves sales nobody can be paid for owed for a later payout", async () => {
    const { b, p } = await setup();
    const r = await finalize({ startDate: "2026-01-01", endDate: "2026-01-31", force: "on" });
    expect(r).toMatchObject({ redirected: expect.stringMatching(/^\/periods\/\d+$/) });

    const listed = await db.select().from(schema.periodSales).where(eq(schema.periodSales.orgId, orgId));
    expect(listed.map((l) => l.dedupeKey)).toEqual(["a-1"]);
    const lines = await db.select().from(schema.payouts).where(eq(schema.payouts.orgId, orgId));
    expect(lines).toMatchObject([{ personId: p.id, amountCents: 1000 }]);

    // Band B gets a split later: its sale is still there to pay.
    const [q] = await db.insert(schema.people).values({ orgId, name: "B member" }).returning();
    const [rule] = await db.insert(schema.splitRules).values({ orgId, scope: "band_default", bandId: b.id }).returning();
    await db.insert(schema.splitShares).values({ orgId, ruleId: rule.id, personId: q.id, bps: 10000 });
    const next = await data.computePayoutPeriod(orgId, { id: 0, startDate: "2026-01-01", endDate: "2026-12-31", bandId: null });
    expect(next.results.map((x) => x.saleId).length).toBe(1);
    expect(next.results[0].problem).toBeNull();
  });

  it("lets an older payout let go of sales it took in without paying anyone", async () => {
    const { a, b, p } = await setup();
    // As payouts used to: every sale in the dates listed, paid or not. Only Band A was paid.
    const [period] = await db
      .insert(schema.periods)
      .values({ orgId, name: "Old", startDate: "2026-01-01", endDate: "2026-01-31", status: "finalized" })
      .returning();
    await db.insert(schema.periodSales).values(["a-1", "b-1"].map((dedupeKey) => ({ orgId, periodId: period.id, dedupeKey })));
    await db.insert(schema.payouts).values({ orgId, periodId: period.id, personId: p.id, currency: "USD", amountCents: 1000, byBand: { [String(a.id)]: 1000 } });
    // Band B got its split after that payout: its sale would be paid now, but that payout paid nobody for it.
    const [q] = await db.insert(schema.people).values({ orgId, name: "B member" }).returning();
    const [rule] = await db.insert(schema.splitRules).values({ orgId, scope: "band_default", bandId: b.id }).returning();
    await db.insert(schema.splitShares).values({ orgId, ruleId: rule.id, personId: q.id, bps: 10000 });

    expect(await data.strandedSales(orgId, period)).toEqual(["b-1"]);
    await actions.releaseUnpaidSales(form({ id: String(period.id) }));
    const listed = await db.select().from(schema.periodSales).where(eq(schema.periodSales.periodId, period.id));
    expect(listed.map((l) => l.dedupeKey)).toEqual(["a-1"]);
    expect(await data.strandedSales(orgId, period)).toEqual([]);
  });
});
