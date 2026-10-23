import "server-only";
import { z } from "zod";
import { schema } from "@/db";
import { deleteExpense, deleteExpenseFile, reviewExpense, saveExpense, setReimbursed } from "../../expense-actions";
import { actionTool } from "../tool";
import { amount, current, currency, date, id, or, toAmount } from "./shared";

/*
 * Receipts (expenses). Sending one in for approval needs the receipt's photo or PDF, so that's on
 * the Receipts page; adding one directly (approved) doesn't.
 */

const saveExpenseTool = actionTool({
  name: "save_expense",
  label: "Save an expense",
  description: `Add an expense (approved straight away), or change one (give its id; only the fields given change). paidBy: label, band_fund (a band's fund: bandId), or person (someone who paid themselves and is owed it back: paidByPersonId). recoup: sales of the band, release or project pay it back. To send in a receipt with its photo for approval, use /receipts.`,
  params: z.object({
    id: id.optional(),
    date: date.optional(),
    description: z.string().min(1).max(300).optional(),
    amount: amount.optional(),
    currency: currency.optional(),
    vendor: z.string().max(120).optional(),
    category: z.string().max(60).optional(),
    paidBy: z.enum(["label", "band_fund", "person"]).optional(),
    paidByPersonId: id.optional(),
    bandId: id.optional(),
    releaseId: id.optional(),
    projectId: id.optional(),
    recoup: z.boolean().optional(),
  }),
  needs: { area: "receipts", level: "edit" },
  action: (fd) => saveExpense(null, fd),
  fields: async (ctx, a) => {
    const e = a.id ? await current(schema.expenses, ctx.orgId, a.id, "expense") : null;
    const paidBy = or(a.paidBy, e?.paidBy ?? "label");
    const personId = or(a.paidByPersonId, e?.paidByPersonId ?? undefined);
    return {
      id: a.id,
      date: or(a.date, e?.date),
      description: or(a.description, e?.description),
      amount: or(a.amount, toAmount(e?.amountCents)),
      currency: or(a.currency, e?.currency),
      vendor: or(a.vendor, e?.vendor ?? undefined),
      category: or(a.category, e?.category ?? undefined),
      paidBy: paidBy === "person" ? `person:${personId ?? ""}` : paidBy,
      bandId: or(a.bandId, e?.bandId ?? undefined),
      releaseId: or(a.releaseId, e?.releaseId ?? undefined),
      projectId: or(a.projectId, e?.projectId ?? undefined),
      recoup: or(a.recoup, e?.recoup ?? false),
    };
  },
});

const review = actionTool({
  name: "review_receipt",
  label: "Review a receipt",
  description: "Approve or reject a receipt someone sent in (receipts lists those waiting: status pending). recoup: when approving, sales pay it back.",
  params: z.object({ expenseId: id, decision: z.enum(["approve", "reject"]), note: z.string().max(500).optional(), recoup: z.boolean().optional() }),
  needs: { area: "receipts", level: "edit" },
  action: (fd) => reviewExpense(fd),
  fields: (_ctx, a) => ({ id: a.expenseId, decision: a.decision, note: a.note, recoup: a.recoup }),
});

const reimbursed = actionTool({
  name: "set_reimbursed",
  label: "Mark a receipt paid back",
  description: "Mark that the label has paid back someone who paid for an expense themselves (or undo that: reimbursed false).",
  params: z.object({ expenseId: id, reimbursed: z.boolean(), reference: z.string().max(120).optional(), method: z.string().max(60).optional() }),
  needs: { area: "receipts", level: "edit" },
  action: (fd) => setReimbursed(fd),
  fields: (_ctx, a) => ({ id: a.expenseId, reimbursed: a.reimbursed ? "true" : "false", reference: a.reference, method: a.method }),
});

const deleteExpenseTool = actionTool({
  name: "delete_expense",
  label: "Delete an expense",
  description: "Delete an expense and its files (or withdraw your own receipt while it's waiting for review).",
  params: z.object({ expenseId: id }),
  needs: "anyone",
  action: (fd) => deleteExpense(fd),
  fields: (_ctx, a) => ({ id: a.expenseId }),
});

const deleteFile = actionTool({
  name: "delete_receipt_file",
  label: "Delete a receipt's file",
  description: "Delete one photo or PDF from a receipt (receipts lists their file ids).",
  params: z.object({ fileId: id }),
  needs: { area: "receipts", level: "edit" },
  action: (fd) => deleteExpenseFile(fd),
  fields: (_ctx, a) => ({ id: a.fileId }),
});

export const RECEIPT_TOOLS = [saveExpenseTool, review, reimbursed, deleteExpenseTool, deleteFile];
