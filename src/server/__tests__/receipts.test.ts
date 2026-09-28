import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { newAccount, testDb } from "../../../test/helpers/db";

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let data: typeof import("../data");
let expenses: typeof import("../expenses");
let links: typeof import("../links");
let periodView: typeof import("../period-view");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  data = await import("../data");
  expenses = await import("../expenses");
  links = await import("../links");
  periodView = await import("../period-view");
});

/** A label with one band, two members splitting 50/50, a 20% label cut, and two $100 sales. */
async function setup() {
  const orgId = await newAccount();
  const { bands, people, bandMemberships, splitRules, splitShares, deductions, imports, sales } = schema;
  const [band] = await db.insert(bands).values({ orgId, name: "Flag Day" }).returning();
  const [a] = await db.insert(people).values({ orgId, name: "Archie" }).returning();
  const [b] = await db.insert(people).values({ orgId, name: "Billy" }).returning();
  await db.insert(bandMemberships).values([
    { orgId, bandId: band.id, personId: a.id },
    { orgId, bandId: band.id, personId: b.id },
  ]);
  const [rule] = await db.insert(splitRules).values({ orgId, scope: "band_default", bandId: band.id }).returning();
  await db.insert(splitShares).values([
    { orgId, ruleId: rule.id, personId: a.id, bps: 5000 },
    { orgId, ruleId: rule.id, personId: b.id, bps: 5000 },
  ]);
  await db.insert(deductions).values({ orgId, label: "Label cut", kind: "percent", percentBps: 2000, destination: "label" });
  const [imp] = await db.insert(imports).values({ orgId, filename: "t", rowCount: 2, addedCount: 2, duplicateCount: 0 }).returning();
  for (const [key, date] of [
    ["jan", "2026-01-10"],
    ["mar", "2026-03-10"],
  ]) {
    await db.insert(sales).values({
      orgId, importId: imp.id, dedupeKey: key, date, itemType: "album", category: "album", itemName: "x", artist: "",
      itemUrl: "", packageName: "", currency: "USD", netCents: 10000, transactionId: key, routingKey: key, bandId: band.id, raw: {},
    });
  }
  return { orgId, band, a, b };
}

const expense = (orgId: string, v: Partial<typeof schema.expenses.$inferInsert>) =>
  db
    .insert(schema.expenses)
    .values({ orgId, date: "2026-02-01", description: "CDs", amountCents: 3000, paidBy: "label", status: "approved", ...v })
    .returning()
    .then((r) => r[0]);

describe("receipts", () => {
  it("pays back someone who fronted an expense from the band's later sales, in their payout", async () => {
    const { orgId, band, a, b } = await setup();
    await expense(orgId, { bandId: band.id, paidBy: "person", paidByPersonId: a.id, recoup: true });
    const { summary } = await data.computeAllTime(orgId);
    const s = summary.byCurrency.USD;
    // January is before the expense, so untouched: $80 after the cut, $40 each.
    // March: $80 after the cut, less $30 back to Archie = $50, $25 each; Archie also gets his $30.
    expect(s.byPerson.get(a.id)!.total).toBe(4000 + 2500 + 3000);
    expect(s.byPerson.get(b.id)!.total).toBe(4000 + 2500);
    expect(s.byDestination.get("label")).toBe(4000);
  });

  it("ignores expenses that aren't approved, and ones not being paid back from sales", async () => {
    const { orgId, band, a, b } = await setup();
    await expense(orgId, { bandId: band.id, paidBy: "person", paidByPersonId: a.id, recoup: true, status: "pending" });
    await expense(orgId, { bandId: band.id, paidBy: "person", paidByPersonId: b.id, recoup: true, status: "rejected" });
    await expense(orgId, { bandId: band.id, paidBy: "label", recoup: false });
    const { summary } = await data.computeAllTime(orgId);
    expect(summary.byCurrency.USD.byPerson.get(a.id)!.total).toBe(8000);
    expect(summary.byCurrency.USD.byPerson.get(b.id)!.total).toBe(8000);
  });

  it("counts what the label spent: expenses it paid, and people it reimbursed", async () => {
    const { orgId, band, a } = await setup();
    await expense(orgId, { bandId: band.id, paidBy: "label", recoup: true }); // paid, and gets it back from sales
    await expense(orgId, { bandId: band.id, paidBy: "person", paidByPersonId: a.id, amountCents: 500, reimbursedAt: "2026-04-01" });
    await expense(orgId, { bandId: band.id, paidBy: "person", paidByPersonId: a.id, amountCents: 700 }); // not reimbursed yet
    const funds = await data.labelFunds(orgId);
    expect(funds.spent.get("USD")).toBe(3000 + 500);
    // Kept: the 20% cut ($40) plus $30 recouped from March's sales.
    expect(funds.kept.get("USD")).toBe(4000 + 3000);
    expect(funds.balance.get("USD")).toBe(7000 - 3500);
  });

  it("lets only the right people open a receipt", async () => {
    const { orgId, band, a } = await setup();
    const e = await expense(orgId, { bandId: band.id, paidBy: "person", paidByPersonId: a.id, submittedByUserId: null });
    const member = { orgId, isAdmin: false, userId: "u-member", personId: a.id };
    expect(await expenses.canViewReceipt(member, e)).toBe(true); // Archie paid it
    expect(await expenses.canViewReceipt({ ...member, personId: 999 }, e)).toBe(false); // another member
    expect(await expenses.canViewReceipt({ ...member, isAdmin: true, personId: null }, e)).toBe(true);

    // An admin of another account: only through an active link to this band.
    const bandAccount = await newAccount("Flag Day", "band");
    const outsider = { orgId: bandAccount, isAdmin: true, userId: "u-band", personId: null };
    expect(await expenses.canViewReceipt(outsider, e)).toBe(false);
    const [link] = await db
      .insert(schema.accountLinks)
      .values({ labelOrgId: orgId, labelBandId: band.id, code: `C-${band.id}`, bandOrgId: bandAccount })
      .returning();
    expect(await expenses.canViewReceipt(outsider, e)).toBe(false); // still pending
    await db.update(schema.accountLinks).set({ status: "active" }).where(eq(schema.accountLinks.id, link.id));
    expect(await expenses.canViewReceipt(outsider, e)).toBe(true);
    expect(await expenses.canViewReceipt({ ...outsider, isAdmin: false }, e)).toBe(false); // band account members don't
  });
});

describe("when an expense starts being paid back", () => {
  it("never reaches into sales that were already paid out", () => {
    const periods = [
      { bandId: 7, endDate: "2026-08-31" }, // this band's own payout
      { bandId: 9, endDate: "2026-11-30" }, // another band's: irrelevant
    ];
    expect(expenses.recoupStart("2026-01-01", 7, periods)).toBe("2026-09-01");
    expect(expenses.recoupStart("2026-10-15", 7, periods)).toBe("2026-10-15"); // after the last payout already
    expect(expenses.recoupStart("2026-01-01", 7, [{ bandId: null, endDate: "2026-12-31" }])).toBe("2027-01-01"); // whole-label payout
    expect(expenses.recoupStart("2026-01-01", 7, [])).toBe("2026-01-01");
  });

  it("uses the stored start in the ledger", async () => {
    const { orgId, band, a } = await setup();
    // Dated before both sales, but January was already paid out: only March pays it back.
    await expense(orgId, { date: "2026-01-01", recoupFrom: "2026-02-01", bandId: band.id, paidBy: "person", paidByPersonId: a.id, recoup: true });
    const jan = await data.computePayoutPeriod(orgId, { id: 0, bandId: null, startDate: "2026-01-01", endDate: "2026-01-31" });
    expect(jan.summary.byCurrency.USD.byPerson.get(a.id)!.total).toBe(4000);
    const mar = await data.computePayoutPeriod(orgId, { id: 0, bandId: null, startDate: "2026-03-01", endDate: "2026-03-31" });
    expect(mar.summary.byCurrency.USD.byPerson.get(a.id)!.total).toBe(2500 + 3000);
  });
});

describe("linking a band's account to its label", () => {
  it("shows the link on both sides only once it's accepted", async () => {
    const { orgId, band } = await setup();
    const bandAccount = await newAccount("Flag Day", "band");
    await db.insert(schema.accountLinks).values({ labelOrgId: orgId, labelBandId: band.id, code: `L-${band.id}` });
    expect((await links.linkForLabelBand(orgId, band.id))?.link.status).toBe("pending");
    expect(await links.labelsForBandAccount(bandAccount)).toEqual([]);
    expect((await links.linkedBandAccounts(orgId)).size).toBe(0);

    await db
      .update(schema.accountLinks)
      .set({ bandOrgId: bandAccount, status: "active" })
      .where(eq(schema.accountLinks.labelBandId, band.id));
    const labels = await links.labelsForBandAccount(bandAccount);
    expect(labels.map((l) => [l.label.id, l.band.id])).toEqual([[orgId, band.id]]);
    expect((await links.linkedBandAccounts(orgId)).get(band.id)).toBe("Flag Day");
  });
});

describe("the 'changed since finalized' warning", () => {
  const line = (personId: number, amountCents: number) => ({ personId, currency: "USD", amountCents });
  it("ignores a cent moving between people (rounding), but not real changes", () => {
    const locked = [line(1, 5120), line(2, 5119)];
    expect(periodView.changedSinceFinalized(locked, [line(1, 5119), line(2, 5120)])).toBe(false);
    expect(periodView.changedSinceFinalized(locked, [line(1, 5121), line(2, 5119)])).toBe(true); // total changed
    expect(periodView.changedSinceFinalized(locked, [line(1, 5000), line(2, 5239)])).toBe(true); // more than a cent
    expect(periodView.changedSinceFinalized(locked, [line(1, 10239)])).toBe(true); // someone dropped out
  });
});
