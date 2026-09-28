import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// A throwaway database for these tests; must be set before the db module loads.
process.env.LABEL_DB = join(mkdtempSync(join(tmpdir(), "label-payouts-periods-")), "test.db");

let db: typeof import("@/db").db;
let schema: typeof import("@/db").schema;
let data: typeof import("../data");

beforeAll(async () => {
  ({ db, schema } = await import("@/db"));
  data = await import("../data");
});

describe("paying bands one at a time", () => {
  it("never pays a sale twice across band and whole-label payouts", () => {
    const { bands, people, splitRules, splitShares, imports, sales, periods } = schema;
    const a = db.insert(bands).values({ name: "Band A" }).returning().get();
    const b = db.insert(bands).values({ name: "Band B" }).returning().get();
    for (const band of [a, b]) {
      const p = db.insert(people).values({ name: `${band.name} member` }).returning().get();
      const rule = db.insert(splitRules).values({ scope: "band_default", bandId: band.id }).returning().get();
      db.insert(splitShares).values({ ruleId: rule.id, personId: p.id, bps: 10000 }).run();
    }
    const imp = db.insert(imports).values({ filename: "t", rowCount: 3, addedCount: 3, duplicateCount: 0 }).returning().get();
    const sale = (key: string, bandId: number, date: string) =>
      db
        .insert(sales)
        .values({
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
        .get();
    const aJan = sale("a-jan", a.id, "2026-01-10");
    const bJan = sale("b-jan", b.id, "2026-01-12");
    const aFeb = sale("a-feb", a.id, "2026-02-05");

    // A preview isn't stored: it's computed for a band and dates (id 0 = not a saved payout).
    const finalize = (name: string, scope: { startDate: string; endDate: string; bandId: number | null }) =>
      db.insert(periods).values({ name, ...scope, status: "finalized" }).returning().get();

    // Pay Band A for January on its own.
    const aScope = { startDate: "2026-01-01", endDate: "2026-01-31", bandId: a.id };
    expect(data.computePayoutPeriod({ id: 0, ...aScope }).results.map((r) => r.saleId)).toEqual([aJan.id]); // not Band B's sale
    const aPeriod = finalize("A Jan", aScope);

    // A whole-label payout for Jan–Feb skips what Band A was already paid.
    const allScope = { startDate: "2026-01-01", endDate: "2026-02-28", bandId: null };
    const label = data.computePayoutPeriod({ id: 0, ...allScope });
    expect(label.results.map((r) => r.saleId).sort()).toEqual([bJan.id, aFeb.id].sort());
    expect(label.alreadyPaid).toEqual([{ period: expect.objectContaining({ id: aPeriod.id }), sales: 1 }]);
    const all = finalize("Jan–Feb", allScope);
    // Once finalized, a payout still sees its own sales (it isn't "already paid" by itself).
    expect(data.computePayoutPeriod(all).results).toHaveLength(2);

    // A later Band B payout over January finds nothing left to pay.
    const bOnly = data.computePayoutPeriod({ id: 0, startDate: "2026-01-01", endDate: "2026-01-31", bandId: b.id });
    expect(bOnly.results).toEqual([]);
    expect(bOnly.alreadyPaid.map((x) => x.period.id)).toEqual([all.id]);
  });
});
