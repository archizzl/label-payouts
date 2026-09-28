import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Deduction } from "@/lib/splits";

export type Expense = typeof schema.expenses.$inferSelect;

/** yyyy-mm-dd plus one day. */
function nextDay(d: string) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

/**
 * When paying an expense back from sales starts: its own date, or, if the band has been paid out
 * since, the day after that payout. Sales already paid out are never taken back.
 */
export function recoupStart(date: string, bandId: number, periods: { bandId: number | null; endDate: string }[]) {
  const lastPaid = periods
    .filter((p) => p.bandId === null || p.bandId === bandId)
    .reduce<string | null>((a, p) => (!a || p.endDate > a ? p.endDate : a), null);
  return lastPaid && lastPaid >= date ? nextDay(lastPaid) : date;
}

export async function recoupStartFor(orgId: string, date: string, bandId: number) {
  const periods = await db
    .select({ bandId: schema.periods.bandId, endDate: schema.periods.endDate })
    .from(schema.periods)
    .where(eq(schema.periods.orgId, orgId));
  return recoupStart(date, bandId, periods);
}

/** Deductions built from expenses have negative ids, so they never clash with real ones. */
export const expenseDeductionId = (expenseId: number) => -expenseId;
export const expenseIdOf = (deductionId: number) => (deductionId < 0 ? -deductionId : null);

/**
 * Approved expenses being paid back from sales, as recoupable costs for the split engine: taken
 * from the band's (or release's) sales made on or after the expense date, in its currency, after
 * the label's cut and the band's own deductions, and paid to whoever paid the bill.
 */
export function expenseDeductions(rows: Expense[]): Deduction[] {
  return rows
    .filter((e) => e.status === "approved" && e.recoup && e.amountCents > 0 && (e.bandId !== null || e.releaseId !== null))
    .filter((e) => e.paidBy !== "person" || e.paidByPersonId !== null)
    .map((e) => ({
      id: expenseDeductionId(e.id),
      label: `Receipt: ${e.description}`,
      kind: "fixed" as const,
      percentBps: null,
      amountCents: e.amountCents,
      currency: e.currency,
      destination: e.paidBy === "person" ? ("person" as const) : e.paidBy === "band_fund" ? ("band_fund" as const) : ("label" as const),
      personId: e.paidBy === "person" ? e.paidByPersonId : null,
      bandId: e.bandId,
      releaseId: e.releaseId,
      trackId: null,
      itemCategory: null,
      formatMatch: null,
      packageId: null,
      effectiveFrom: e.recoupFrom ?? e.date,
      effectiveTo: null,
      // After the band's own percentage deductions.
      sortOrder: 100,
    }));
}

export async function accountExpenses(orgId: string, where?: { bandId?: number }) {
  return db
    .select()
    .from(schema.expenses)
    .where(and(eq(schema.expenses.orgId, orgId), where?.bandId !== undefined ? eq(schema.expenses.bandId, where.bandId) : undefined))
    .orderBy(desc(schema.expenses.date), desc(schema.expenses.id));
}

/** Receipt files (name, type, size; not the bytes) for these expenses. */
export async function expenseFileList(orgId: string) {
  const rows = await db
    .select({
      id: schema.expenseFiles.id,
      expenseId: schema.expenseFiles.expenseId,
      filename: schema.expenseFiles.filename,
      contentType: schema.expenseFiles.contentType,
      size: schema.expenseFiles.size,
    })
    .from(schema.expenseFiles)
    .where(eq(schema.expenseFiles.orgId, orgId));
  const byExpense = new Map<number, typeof rows>();
  for (const f of rows) byExpense.set(f.expenseId, [...(byExpense.get(f.expenseId) ?? []), f]);
  return byExpense;
}

/** How an expense is covered, in words. */
export function coverageText(e: Expense, personName: (id: number) => string | undefined) {
  const payer = e.paidBy === "label" ? "the label" : e.paidBy === "band_fund" ? "the band fund" : (personName(e.paidByPersonId ?? 0) ?? "someone");
  const paid = `Paid by ${payer}`;
  if (e.status === "pending") return `${paid}; waiting for an admin`;
  if (e.status === "rejected") return paid;
  if (e.recoup) return `${paid}; paid back from sales${e.recoupFrom && e.recoupFrom !== e.date ? ` from ${e.recoupFrom}` : ""}`;
  if (e.paidBy === "person") return `${paid}; the label pays them back`;
  return paid;
}

/** An approved expense that someone fronted and the label still owes them (not paid back from sales). */
export const owedReimbursement = (e: Expense) => e.status === "approved" && e.paidBy === "person" && !e.recoup && !e.reimbursedAt;

export type Viewer = { orgId: string; isAdmin: boolean; userId: string; personId: number | null };

/**
 * Who may open a receipt: admins of the account it belongs to, whoever submitted or paid it, and
 * admins of a band account linked (actively) to that expense's band.
 */
export async function canViewReceipt(viewer: Viewer, expense: Expense): Promise<boolean> {
  if (expense.orgId === viewer.orgId) {
    return viewer.isAdmin || expense.submittedByUserId === viewer.userId || (viewer.personId !== null && expense.paidByPersonId === viewer.personId);
  }
  if (!viewer.isAdmin || expense.bandId === null) return false;
  const [link] = await db
    .select({ id: schema.accountLinks.id })
    .from(schema.accountLinks)
    .where(
      and(
        eq(schema.accountLinks.labelOrgId, expense.orgId),
        eq(schema.accountLinks.labelBandId, expense.bandId),
        eq(schema.accountLinks.bandOrgId, viewer.orgId),
        eq(schema.accountLinks.status, "active"),
      ),
    );
  return !!link;
}
