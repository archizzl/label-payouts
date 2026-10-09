import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { batchFiles, isSettled } from "@/lib/receipt-cleanup";
import { computeAllTime } from "./data";
import { expenseDeductionId } from "./expenses";

/*
 * Receipt files that can be cleared out: those of settled receipts (src/lib/receipt-cleanup.ts),
 * offered as downloads first, then removed from storage. The receipts themselves stay.
 */

const { expenses, expenseFiles } = schema;

/** How much of each receipt sales have paid back so far: expense id → cents. */
async function recoupedByExpense(orgId: string, expenseIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!expenseIds.length) return out;
  const wanted = new Map(expenseIds.map((id) => [expenseDeductionId(id), id]));
  const { results } = await computeAllTime(orgId);
  for (const r of results) {
    for (const d of r.deductions) {
      const id = wanted.get(d.deductionId);
      if (id !== undefined) out.set(id, (out.get(id) ?? 0) + d.cents);
    }
  }
  return out;
}

export type ClearableFile = { id: number; expenseId: number; size: number; filename: string; date: string; description: string };

/** Every file belonging to a settled receipt, oldest receipt first, in download-sized parts. */
export async function clearableFiles(orgId: string, onlyIds?: number[]) {
  const rows = await db
    .select({
      id: expenseFiles.id,
      expenseId: expenseFiles.expenseId,
      size: expenseFiles.size,
      filename: expenseFiles.filename,
      expense: expenses,
    })
    .from(expenseFiles)
    .innerJoin(expenses, eq(expenses.id, expenseFiles.expenseId))
    .where(and(eq(expenseFiles.orgId, orgId), onlyIds ? inArray(expenseFiles.id, onlyIds.length ? onlyIds : [-1]) : undefined));
  const recouping = [...new Set(rows.filter((r) => r.expense.recoup && r.expense.status === "approved").map((r) => r.expenseId))];
  const recouped = await recoupedByExpense(orgId, recouping);
  const files: ClearableFile[] = rows
    .filter((r) => isSettled(r.expense, recouped.get(r.expenseId) ?? 0))
    .sort((a, b) => a.expense.date.localeCompare(b.expense.date) || a.id - b.id)
    .map((r) => ({ id: r.id, expenseId: r.expenseId, size: r.size, filename: r.filename, date: r.expense.date, description: r.expense.description }));
  return { files, batches: batchFiles(files), receipts: new Set(files.map((f) => f.expenseId)).size };
}
