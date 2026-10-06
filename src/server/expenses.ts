import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Deduction } from "@/lib/splits";

export type Expense = typeof schema.expenses.$inferSelect;

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 10;
const ALLOWED = /^(image\/(jpeg|png|gif|webp|heic|heif)|application\/pdf)$/;

/** Receipt photos and PDFs from a form; refuses anything else, or anything too big. */
export async function readReceiptFiles(fd: FormData, field = "files") {
  const files = fd.getAll(field).filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length > MAX_FILES) throw new Error(`Up to ${MAX_FILES} files at a time.`);
  return Promise.all(
    files.map(async (f) => {
      if (!ALLOWED.test(f.type)) throw new Error(`“${f.name}” isn’t a photo or PDF.`);
      if (f.size > MAX_FILE_BYTES) throw new Error(`“${f.name}” is over 10 MB.`);
      return { filename: f.name.slice(0, 200), contentType: f.type, size: f.size, data: new Uint8Array(await f.arrayBuffer()) };
    }),
  );
}


/** yyyy-mm-dd plus one day. */
function nextDay(d: string) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

/**
 * When paying an expense back from sales starts: its own date, or, if any of the bands whose sales
 * pay it back has been paid out since, the day after that payout. Sales already paid out are never
 * taken back.
 */
export function recoupStart(date: string, bandIds: number | number[], periods: { bandId: number | null; endDate: string }[]) {
  const bands = Array.isArray(bandIds) ? bandIds : [bandIds];
  const lastPaid = periods
    .filter((p) => p.bandId === null || bands.includes(p.bandId))
    .reduce<string | null>((a, p) => (!a || p.endDate > a ? p.endDate : a), null);
  return lastPaid && lastPaid >= date ? nextDay(lastPaid) : date;
}

export async function recoupStartFor(orgId: string, date: string, bandIds: number | number[]) {
  const periods = await db
    .select({ bandId: schema.periods.bandId, endDate: schema.periods.endDate })
    .from(schema.periods)
    .where(eq(schema.periods.orgId, orgId));
  return recoupStart(date, bandIds, periods);
}

/** Each project's releases (and merch items), by project id. */
export async function projectReleaseMap(orgId: string) {
  const rows = await db
    .select({ projectId: schema.projectReleases.projectId, releaseId: schema.projectReleases.releaseId })
    .from(schema.projectReleases)
    .where(eq(schema.projectReleases.orgId, orgId));
  const m = new Map<number, number[]>();
  for (const r of rows) m.set(r.projectId, [...(m.get(r.projectId) ?? []), r.releaseId]);
  return m;
}

/**
 * The bands whose sales pay an expense back: its release's band; else the bands of its project's
 * releases; else its band.
 */
export async function recoupBands(orgId: string, e: { bandId: number | null; releaseId: number | null; projectId: number | null }) {
  const releaseBands = async (ids: number[]) =>
    ids.length
      ? (
          await db
            .select({ bandId: schema.releases.bandId })
            .from(schema.releases)
            .where(and(eq(schema.releases.orgId, orgId), inArray(schema.releases.id, ids)))
        ).map((r) => r.bandId)
      : [];
  if (e.releaseId) return releaseBands([e.releaseId]);
  if (e.projectId) {
    const ids = (await projectReleaseMap(orgId)).get(e.projectId) ?? [];
    const bands = await releaseBands(ids);
    if (bands.length) return [...new Set(bands)];
  }
  return e.bandId ? [e.bandId] : [];
}

/** Deductions built from expenses have negative ids, so they never clash with real ones. */
export const expenseDeductionId = (expenseId: number) => -expenseId;
export const expenseIdOf = (deductionId: number) => (deductionId < 0 ? -deductionId : null);

/**
 * Approved expenses being paid back from sales, as recoupable costs for the split engine: taken
 * from the sales of its release, else of its project's releases, else of its band, made on or
 * after `recoupFrom`, in its currency, after the label's cut and the band's own deductions, and
 * paid to whoever paid the bill.
 */
export function expenseDeductions(rows: Expense[], projectReleases: Map<number, number[]> = new Map()): Deduction[] {
  return rows
    .filter((e) => e.status === "approved" && e.recoup && e.amountCents > 0)
    .filter((e) => e.paidBy !== "person" || e.paidByPersonId !== null)
    .map((e) => {
      // A project's releases, when the expense isn't tied to one release.
      const releaseIds = !e.releaseId && e.projectId ? (projectReleases.get(e.projectId) ?? []) : [];
      return { e, releaseIds };
    })
    .filter(({ e, releaseIds }) => e.releaseId !== null || releaseIds.length > 0 || e.bandId !== null)
    .map(({ e, releaseIds }) => ({
      id: expenseDeductionId(e.id),
      label: `Receipt: ${e.description}`,
      kind: "fixed" as const,
      percentBps: null,
      amountCents: e.amountCents,
      currency: e.currency,
      destination: e.paidBy === "person" ? ("person" as const) : e.paidBy === "band_fund" ? ("band_fund" as const) : ("label" as const),
      personId: e.paidBy === "person" ? e.paidByPersonId : null,
      // A project's releases can span bands, so the release list does the narrowing there.
      bandId: releaseIds.length ? null : e.bandId,
      releaseId: e.releaseId,
      releaseIds: releaseIds.length ? releaseIds : null,
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
