import { beforeAll, describe, expect, it } from "vitest";
import { newAccount, testDb } from "../../../test/helpers/db";

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let income: typeof import("../label-income");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  income = await import("../label-income");
});

describe("where the label's money comes from", () => {
  it("breaks it down by withholding, shipping and label releases; keeps the account holder's share apart", async () => {
    const orgId = await newAccount();
    const { bands, people, splitRules, splitShares, deductions, imports, sales, labelTransfers } = schema;
    const [band] = await db.insert(bands).values({ orgId, name: "Flag Day" }).returning();
    const [labelBand] = await db.insert(bands).values({ orgId, name: "The Label", isLabel: true }).returning();
    const [me] = await db.insert(people).values({ orgId, name: "Archie", holdsLabelAccount: true }).returning();
    const [them] = await db.insert(people).values({ orgId, name: "Henry" }).returning();
    const [rule] = await db.insert(splitRules).values({ orgId, scope: "band_default", bandId: band.id }).returning();
    await db.insert(splitShares).values([
      { orgId, ruleId: rule.id, personId: me.id, bps: 5000 },
      { orgId, ruleId: rule.id, personId: them.id, bps: 5000 },
    ]);
    await db.insert(deductions).values({ orgId, label: "CD costs", kind: "per_unit", amountCents: 400, currency: "USD", destination: "label", itemCategory: "merch" });
    const [imp] = await db.insert(imports).values({ orgId, filename: "t", rowCount: 2, addedCount: 2, duplicateCount: 0 }).returning();
    const sale = (key: string, bandId: number, category: "album" | "merch", netCents: number, raw: Record<string, string>) =>
      db.insert(sales).values({
        orgId, importId: imp.id, dedupeKey: key, date: "2026-10-02", itemType: category, category, itemName: key, artist: "", itemUrl: "",
        packageName: "", currency: "USD", netCents, transactionId: key, routingKey: key, bandId, raw,
      });
    await sale("cd", band.id, "merch", 935, { shipping: "4.50" }); // −$4 CD costs → $5.35 split 50/50
    await sale("comp", labelBand.id, "album", 700, {}); // label release, no split: the label keeps it
    await db.insert(labelTransfers).values({ orgId, date: "2026-10-03", recipient: "Aid group", currency: "USD", amountCents: 100, source: "CD costs" });

    const i = await income.labelIncome(orgId);
    expect(Object.fromEntries([...i.bySource].map(([k, t]) => [k, t.get("USD")]))).toEqual({
      "CD costs": 400,
      [income.SHIPPING_SOURCE]: 450,
      [income.LABEL_RELEASES_SOURCE]: 700,
    });
    expect(i.income.get("USD")).toBe(1550);
    expect(i.balance.get("USD")).toBe(1450); // minus the $1 sent on
    expect(i.holderShare.get("USD")).toBe(268); // Archie's half of $5.35, not counted as the label's
    expect(i.holderName).toBe("Archie");
    expect(i.sentBySource.get("CD costs")?.get("USD")).toBe(100); // sent out of that source

    const sources = (await income.incomeSources(orgId)).map((x) => x.label);
    expect(sources).toEqual(["CD costs", income.LABEL_RELEASES_SOURCE, income.SHIPPING_SOURCE]);
  });
});
