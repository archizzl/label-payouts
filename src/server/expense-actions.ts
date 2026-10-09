"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { parseCents } from "@/lib/money";
import { getContext, requireAccess } from "./context";
import { can } from "@/lib/permissions";
import { readReceiptFiles as readFiles, recoupBands, recoupStartFor } from "./expenses";
import { discardStoredFiles, storeReceiptFiles } from "./receipt-store";

/*
 * Receipts. Admins add expenses directly (approved) and review what members submit. Members submit
 * receipts for things they paid for; nothing counts until an admin approves it.
 */

export type ExpenseState = { ok?: string; error?: string } | null;

const { expenses, expenseFiles, bands, releases, people, bandMemberships, projects } = schema;

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const optInt = (fd: FormData, k: string) => {
  const n = Number.parseInt(str(fd, k), 10);
  return Number.isFinite(n) ? n : null;
};
const isoDate = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
const now = () => new Date().toISOString();

/** Check a band/release/person id belongs to this account. */
async function inAccount(orgId: string, table: typeof bands | typeof releases | typeof people | typeof projects, id: number | null) {
  if (id === null) return;
  const [row] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.orgId, orgId), eq(table.id, id)));
  if (!row) throw new Error("That item isn't part of this account.");
}

function done() {
  revalidatePath("/", "layout");
}

function describe(e: unknown) {
  return e instanceof Error && !e.message.startsWith("NEXT_") ? e.message : "Something went wrong.";
}

/** Admin: add or edit an expense. New ones count straight away (they're approved). */
export async function saveExpense(_: ExpenseState, fd: FormData): Promise<ExpenseState> {
  const ctx = await requireAccess("receipts", "edit");
  const { orgId } = ctx;
  try {
    const date = isoDate(str(fd, "date"));
    const description = str(fd, "description");
    const amountCents = parseCents(str(fd, "amount"));
    if (!date) return { error: "Pick the date." };
    if (!description) return { error: "Say what it was for." };
    if (!(amountCents > 0)) return { error: "Enter the amount." };
    const paidByRaw = str(fd, "paidBy");
    const paidByPersonId = paidByRaw.startsWith("person:") ? Number(paidByRaw.slice(7)) || null : null;
    const paidBy = paidByPersonId ? "person" : paidByRaw === "band_fund" ? "band_fund" : "label";
    const releaseId = optInt(fd, "releaseId");
    const projectId = optInt(fd, "projectId");
    let bandId = optInt(fd, "bandId");
    await inAccount(orgId, releases, releaseId);
    await inAccount(orgId, bands, bandId);
    await inAccount(orgId, people, paidByPersonId);
    await inAccount(orgId, projects, projectId);
    if (releaseId) {
      const [r] = await db.select({ bandId: releases.bandId }).from(releases).where(eq(releases.id, releaseId));
      bandId = r.bandId; // a release implies its band
    } else if (projectId && !bandId) {
      const [p] = await db.select({ bandId: projects.bandId }).from(projects).where(eq(projects.id, projectId));
      bandId = p.bandId; // so does a band's project
    }
    const recoup = fd.get("recoup") === "on";
    const scope = { bandId, releaseId, projectId };
    const payingBands = recoup ? await recoupBands(orgId, scope) : [];
    if (recoup && !payingBands.length) {
      return { error: "To pay it back from sales, choose the band, release or project (with releases) whose sales pay for it." };
    }
    if (paidBy === "band_fund" && !bandId) return { error: "Choose which band's fund paid for it." };
    const files = await readFiles(fd);
    const id = optInt(fd, "id");
    // Keep an existing start when editing, unless what pays it back changed; never reach into
    // paid-out sales.
    const [current] = id ? await db.select().from(expenses).where(and(eq(expenses.orgId, orgId), eq(expenses.id, id))) : [];
    const sameScope = current && current.date === date && current.bandId === bandId && current.releaseId === releaseId && current.projectId === projectId;
    const recoupFrom = recoup ? (sameScope && current.recoupFrom ? current.recoupFrom : await recoupStartFor(orgId, date, payingBands)) : null;
    const values = {
      date,
      description,
      vendor: str(fd, "vendor") || null,
      category: str(fd, "category") || null,
      amountCents,
      currency: (str(fd, "currency") || "USD").toUpperCase(),
      bandId,
      releaseId,
      projectId,
      paidBy: paidBy as "label" | "band_fund" | "person",
      paidByPersonId,
      recoup,
      recoupFrom,
    };
    const stored = await storeReceiptFiles(orgId, files);
    await db.transaction(async (tx) => {
      let expenseId = id;
      if (id) {
        const [row] = await tx
          .update(expenses)
          .set(values)
          .where(and(eq(expenses.orgId, orgId), eq(expenses.id, id)))
          .returning({ id: expenses.id });
        if (!row) throw new Error("Expense not found.");
      } else {
        [{ id: expenseId }] = await tx
          .insert(expenses)
          .values({ ...values, orgId, status: "approved", reviewedAt: now(), submittedByUserId: ctx.user.id })
          .returning({ id: expenses.id });
      }
      if (stored.length) await tx.insert(expenseFiles).values(stored.map((f) => ({ ...f, orgId, expenseId: expenseId! })));
    }).catch(async (e) => {
      await discardStoredFiles(stored);
      throw e;
    });
    done();
    return { ok: id ? "Saved." : "Added." };
  } catch (e) {
    return { error: describe(e) };
  }
}

/** Member: submit a receipt for something you paid for. An admin approves it before it counts. */
export async function submitReceipt(_: ExpenseState, fd: FormData): Promise<ExpenseState> {
  const ctx = await getContext();
  const { orgId, person } = ctx;
  if (!person) return { error: "Your login isn’t linked to anyone who gets paid here yet." };
  try {
    const date = isoDate(str(fd, "date"));
    const description = str(fd, "description");
    const amountCents = parseCents(str(fd, "amount"));
    if (!date) return { error: "Pick the date." };
    if (!description) return { error: "Say what it was for." };
    if (!(amountCents > 0)) return { error: "Enter the amount." };
    const files = await readFiles(fd);
    if (!files.length) return { error: "Attach a photo or PDF of the receipt." };
    // Members can only file against bands they're in.
    const bandId = optInt(fd, "bandId");
    if (bandId !== null) {
      const [m] = await db
        .select({ id: bandMemberships.id })
        .from(bandMemberships)
        .where(and(eq(bandMemberships.orgId, orgId), eq(bandMemberships.bandId, bandId), eq(bandMemberships.personId, person.id)));
      if (!m) return { error: "You can only submit receipts for your own bands." };
    }
    // A project of one of their bands.
    const projectId = optInt(fd, "projectId");
    if (projectId !== null) {
      const [p] = await db
        .select({ bandId: projects.bandId })
        .from(projects)
        .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)));
      const theirs =
        p?.bandId != null &&
        (
          await db
            .select({ id: bandMemberships.id })
            .from(bandMemberships)
            .where(and(eq(bandMemberships.orgId, orgId), eq(bandMemberships.bandId, p.bandId), eq(bandMemberships.personId, person.id)))
        ).length > 0;
      if (!theirs) return { error: "You can only submit receipts for your own bands' projects." };
    }
    const stored = await storeReceiptFiles(orgId, files);
    await db.transaction(async (tx) => {
      const [{ id }] = await tx
        .insert(expenses)
        .values({
          orgId,
          date,
          description,
          vendor: str(fd, "vendor") || null,
          category: str(fd, "category") || null,
          projectId,
          amountCents,
          currency: (str(fd, "currency") || "USD").toUpperCase(),
          bandId,
          paidBy: "person",
          paidByPersonId: person.id,
          status: "pending",
          submittedByUserId: ctx.user.id,
        })
        .returning({ id: expenses.id });
      await tx.insert(expenseFiles).values(stored.map((f) => ({ ...f, orgId, expenseId: id })));
    }).catch(async (e) => {
      await discardStoredFiles(stored);
      throw e;
    });
    done();
    return { ok: "Submitted. An admin will review it." };
  } catch (e) {
    return { error: describe(e) };
  }
}

/** Admin: approve a submitted receipt (choosing whether sales pay it back) or reject it. */
export async function reviewExpense(fd: FormData) {
  const { orgId } = await requireAccess("receipts", "edit");
  const approve = str(fd, "decision") === "approve";
  const recoup = fd.get("recoup") === "on";
  const [e] = await db
    .select()
    .from(expenses)
    .where(and(eq(expenses.orgId, orgId), eq(expenses.id, Number(str(fd, "id")))));
  if (!e) return;
  const payingBands = approve && recoup ? await recoupBands(orgId, e) : [];
  if (approve && recoup && !payingBands.length) {
    throw new Error("Choose a band, release or project for this expense first (edit it), so its sales can pay it back.");
  }
  await db
    .update(expenses)
    .set({
      status: approve ? "approved" : "rejected",
      recoup: approve ? recoup : e.recoup,
      recoupFrom: approve && recoup ? await recoupStartFor(orgId, e.date, payingBands) : e.recoupFrom,
      reviewNote: str(fd, "note") || null,
      reviewedAt: now(),
    })
    .where(eq(expenses.id, e.id));
  done();
}

/** Admin: the label has paid back someone who fronted an expense (or undo that). */
export async function setReimbursed(fd: FormData) {
  const { orgId } = await requireAccess("receipts", "edit");
  const reimbursed = str(fd, "reimbursed") === "true";
  await db
    .update(expenses)
    .set({
      reimbursedAt: reimbursed ? now() : null,
      reimbursedReference: reimbursed ? str(fd, "reference") || null : null,
      reimbursedMethod: reimbursed ? str(fd, "method") || null : null,
    })
    .where(and(eq(expenses.orgId, orgId), eq(expenses.id, Number(str(fd, "id")))));
  done();
}

/** Admins (and members who can change receipts) can delete any expense; members can withdraw their own while it's still pending. */
export async function deleteExpense(fd: FormData) {
  const ctx = await getContext();
  const [e] = await db
    .select()
    .from(expenses)
    .where(and(eq(expenses.orgId, ctx.orgId), eq(expenses.id, Number(str(fd, "id")))));
  if (!e) return;
  const ownPending = e.status === "pending" && e.submittedByUserId === ctx.user.id;
  if (!can(ctx.access, "receipts", "edit") && !ownPending) throw new Error("Only admins can delete this.");
  const files = await db.select({ storageKey: expenseFiles.storageKey }).from(expenseFiles).where(eq(expenseFiles.expenseId, e.id));
  await db.delete(expenses).where(eq(expenses.id, e.id));
  await discardStoredFiles(files);
  done();
}

export async function deleteExpenseFile(fd: FormData) {
  const { orgId } = await requireAccess("receipts", "edit");
  const removed = await db
    .delete(expenseFiles)
    .where(and(eq(expenseFiles.orgId, orgId), inArray(expenseFiles.id, [Number(str(fd, "id"))])))
    .returning({ storageKey: expenseFiles.storageKey });
  await discardStoredFiles(removed);
  done();
}
