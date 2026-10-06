import { beforeAll, describe, expect, it } from "vitest";
import { newAccount, testDb } from "../../../test/helpers/db";

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let owed: typeof import("../owed");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  owed = await import("../owed");
});

describe("who's owed what", () => {
  it("adds up unpaid payouts, sales not in a payout yet, receipts and money raised for a cause, band by band", async () => {
    const orgId = await newAccount();
    const { bands, people, releases, deductions, splitRules, splitShares, imports, sales, labelTransfers, periods, payouts, expenses } = schema;
    const [band] = await db.insert(bands).values({ orgId, name: "Flag Day" }).returning();
    const [member] = await db.insert(people).values({ orgId, name: "Member" }).returning();
    const [holder] = await db.insert(people).values({ orgId, name: "Label holder", holdsLabelAccount: true }).returning();
    const [rule] = await db.insert(splitRules).values({ orgId, scope: "band_default", bandId: band.id }).returning();
    await db.insert(splitShares).values({ orgId, ruleId: rule.id, personId: member.id, bps: 10000 });
    const [benefit] = await db.insert(releases).values({ orgId, bandId: band.id, title: "Benefit EP" }).returning();
    const [album] = await db.insert(releases).values({ orgId, bandId: band.id, title: "Album" }).returning();
    await db.insert(deductions).values({ orgId, label: "Label cut", kind: "percent", percentBps: 2000, destination: "label" });
    await db
      .insert(deductions)
      .values({ orgId, label: "Fundraiser", kind: "percent", percentBps: 10000, destination: "label", releaseId: benefit.id, sortOrder: -1 });
    const [imp] = await db.insert(imports).values({ orgId, filename: "t", rowCount: 2, addedCount: 2, duplicateCount: 0 }).returning();
    const sale = (key: string, releaseId: number, netCents: number) =>
      db.insert(sales).values({
        orgId, importId: imp.id, dedupeKey: key, date: "2026-03-01", itemType: "album", category: "album", itemName: key, artist: "",
        itemUrl: "", packageName: "", currency: "USD", netCents, transactionId: key, routingKey: key, bandId: band.id, releaseId, raw: {},
      });
    await sale("benefit", benefit.id, 10000);
    await sale("album", album.id, 1000);
    await db
      .insert(labelTransfers)
      .values({ orgId, date: "2026-04-01", recipient: "Aid group", currency: "USD", amountCents: 6000, bandId: band.id, releaseId: benefit.id });

    // An earlier payout, finalized but not paid: the member's 25.00 is owed; the label holder's isn't sent.
    const [period] = await db.insert(periods).values({ orgId, name: "January", startDate: "2026-01-01", endDate: "2026-01-31", status: "finalized" }).returning();
    await db.insert(payouts).values([
      { orgId, periodId: period.id, personId: member.id, currency: "USD", amountCents: 2500, byBand: { [band.id]: 2500 } },
      { orgId, periodId: period.id, personId: holder.id, currency: "USD", amountCents: 900, byBand: { [band.id]: 900 } },
    ]);
    // A receipt the member paid for, approved, that the label pays back directly.
    await db.insert(expenses).values({
      orgId, date: "2026-02-01", description: "Strings", amountCents: 1500, currency: "USD", bandId: band.id, paidBy: "person",
      paidByPersonId: member.id, status: "approved",
    });

    const rows = await owed.owedByBand(orgId);
    const flagDay = rows.find((r) => r.kind === "band")!;
    expect(flagDay).toMatchObject({ name: "Flag Day", finalized: 2500, unpaid: 800, receipts: 1500, raised: 0 });
    expect(flagDay.people).toEqual([{ name: "Member", cents: 4800 }]);
    const group = rows.find((r) => r.kind === "group")!;
    expect(group).toMatchObject({ name: "Aid group (via Flag Day)", raised: 4000 });
  });

  it("is empty when nothing is owed", async () => {
    expect(await owed.owedByBand(await newAccount())).toEqual([]);
  });
});
