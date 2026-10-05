import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/client";
import { Badge, Disclosure, Empty, Field, Money } from "@/components/ui";
import type { schema } from "@/db";
import { centsToDecimal } from "@/lib/money";
import { deleteExpense, deleteExpenseFile, reviewExpense, saveExpense, setReimbursed, submitReceipt } from "@/server/expense-actions";
import { coverageText, type Expense, owedReimbursement } from "@/server/expenses";

type Band = Pick<typeof schema.bands.$inferSelect, "id" | "name">;
type Release = Pick<typeof schema.releases.$inferSelect, "id" | "title" | "bandId">;
type Person = { id: number; name: string };
export type ReceiptFile = { id: number; expenseId: number; filename: string; contentType: string; size: number };

const today = () => new Date().toLocaleDateString("en-CA"); // local yyyy-mm-dd

const STATUS = {
  pending: { label: "Waiting for approval", tone: "warn" },
  approved: { label: "Approved", tone: "good" },
  rejected: { label: "Rejected", tone: "bad" },
} as const;

/** Receipt photo/PDF picker. */
function FilesField({ required }: { required?: boolean }) {
  return (
    <Field label={required ? "Receipt" : "Receipts (optional)"} hint="Photos or PDFs, up to 10 MB each." className="sm:col-span-3">
      <input name="files" type="file" multiple accept="image/*,application/pdf" required={required} className="text-sm" />
    </Field>
  );
}

type ProjectOption = { id: number; name: string; bandId: number | null };

/** Kinds of cost, suggested (any text works). */
export const EXPENSE_CATEGORIES = [
  "Studio time",
  "Session musicians",
  "Producer",
  "Mixing",
  "Mastering",
  "Manufacturing",
  "Artwork & design",
  "Photos & video",
  "Promotion & PR",
  "Travel",
  "Gear & rentals",
  "Shipping",
  "Other",
];

function CategoryField({ value }: { value?: string | null }) {
  return (
    <Field label="Kind of cost">
      <input name="category" list="expense-categories" defaultValue={value ?? ""} placeholder="Studio time" />
      <datalist id="expense-categories">
        {EXPENSE_CATEGORIES.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
    </Field>
  );
}

function ProjectField({ projects, value, hint }: { projects: ProjectOption[]; value?: number | null; hint?: string }) {
  if (!projects.length) return null;
  return (
    <Field label="Project (optional)" hint={hint}>
      <select name="projectId" defaultValue={value ?? ""}>
        <option value="">Not part of a project</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** Admin: add an expense (counts straight away), or edit one. */
export function ExpenseForm({
  expense,
  bands,
  releases,
  people,
  bandId,
  projects = [],
  projectId,
}: {
  expense?: Expense;
  bands: Band[];
  releases: Release[];
  people: Person[];
  /** Pre-select (and limit to) this band, e.g. on a band's page. */
  bandId?: number;
  projects?: ProjectOption[];
  /** Pre-select this project, e.g. on a project's page. */
  projectId?: number;
}) {
  const e = expense;
  const paidBy = e ? (e.paidBy === "person" ? `person:${e.paidByPersonId}` : e.paidBy) : "label";
  return (
    <ActionForm action={saveExpense} className="grid gap-4 sm:grid-cols-3">
      {e && <input type="hidden" name="id" value={e.id} />}
      <Field label="What for" className="sm:col-span-2">
        <input name="description" required defaultValue={e?.description} placeholder="CD pressing, 300 copies" />
      </Field>
      <Field label="Date">
        <input name="date" type="date" required defaultValue={e?.date ?? today()} />
      </Field>
      <Field label="Amount">
        <span className="flex gap-2">
          <input name="amount" required inputMode="decimal" defaultValue={e ? centsToDecimal(e.amountCents) : ""} placeholder="1026.00" />
          <input name="currency" defaultValue={e?.currency ?? "USD"} className="!w-20" aria-label="Currency" />
        </span>
      </Field>
      <Field label="From (optional)">
        <input name="vendor" defaultValue={e?.vendor ?? ""} placeholder="Disc Makers" />
      </Field>
      <CategoryField value={e?.category} />
      <ProjectField
        projects={projects.filter((p) => !bandId || p.bandId === bandId || p.bandId === null)}
        value={e?.projectId ?? projectId}
        hint="Counts toward what the project cost."
      />
      <Field label="Band">
        <select name="bandId" defaultValue={e?.bandId ?? bandId ?? ""}>
          {!bandId && <option value="">The whole label</option>}
          {bands
            .filter((b) => !bandId || b.id === bandId)
            .map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
        </select>
      </Field>
      <Field label="Release (optional)" hint="Pay it back from just this release's sales.">
        <select name="releaseId" defaultValue={e?.releaseId ?? ""}>
          <option value="">Any of the band’s sales</option>
          {bands
            .filter((b) => !bandId || b.id === bandId)
            .map((b) => (
              <optgroup key={b.id} label={b.name}>
                {releases
                  .filter((r) => r.bandId === b.id)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.title}
                    </option>
                  ))}
              </optgroup>
            ))}
        </select>
      </Field>
      <Field label="Who paid">
        <select name="paidBy" defaultValue={paidBy}>
          <option value="label">The label</option>
          <option value="band_fund">The band fund</option>
          <optgroup label="Someone, out of pocket">
            {people.map((p) => (
              <option key={p.id} value={`person:${p.id}`}>
                {p.name}
              </option>
            ))}
          </optgroup>
        </select>
      </Field>
      <label className="flex items-start gap-2 text-sm sm:col-span-2">
        <input type="checkbox" name="recoup" defaultChecked={e?.recoup} className="mt-1" />
        <span>
          <b>Pay it back from sales</b>
          <span className="block text-muted">
            Taken from sales not yet paid out (of the release, else the project’s releases, else the band), before they’re split,
            until it’s covered. The money goes back to whoever paid. Unticked, and someone paid out of pocket, the label reimburses
            them.
          </span>
        </span>
      </label>
      <FilesField />
      <div className="sm:col-span-3">
        <SubmitButton>{e ? "Save" : "Add expense"}</SubmitButton>
      </div>
    </ActionForm>
  );
}

/** Member: submit a receipt for something you paid for. */
export function SubmitReceiptForm({ bands, projects = [] }: { bands: Band[]; projects?: ProjectOption[] }) {
  return (
    <ActionForm action={submitReceipt} className="grid gap-4 sm:grid-cols-3">
      <Field label="What for" className="sm:col-span-2">
        <input name="description" required placeholder="Gas for the Philly show" />
      </Field>
      <Field label="Date">
        <input name="date" type="date" required defaultValue={today()} />
      </Field>
      <Field label="Amount">
        <span className="flex gap-2">
          <input name="amount" required inputMode="decimal" placeholder="42.50" />
          <input name="currency" defaultValue="USD" className="!w-20" aria-label="Currency" />
        </span>
      </Field>
      <Field label="From (optional)">
        <input name="vendor" placeholder="Where you bought it" />
      </Field>
      <CategoryField />
      <ProjectField projects={projects} />
      <Field label="For">
        <select name="bandId" defaultValue={bands[0]?.id ?? ""}>
          {bands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
          <option value="">Something else</option>
        </select>
      </Field>
      <FilesField required />
      <div className="sm:col-span-3">
        <SubmitButton>Submit receipt</SubmitButton>
      </div>
    </ActionForm>
  );
}

function Files({ files, admin }: { files: ReceiptFile[]; admin: boolean }) {
  if (!files.length) return <span className="text-xs text-muted">no receipt attached</span>;
  return (
    <span className="flex flex-wrap gap-2">
      {files.map((f) => (
        <span key={f.id} className="inline-flex items-center gap-1">
          <a href={`/receipts/file/${f.id}`} target="_blank" rel="noreferrer" title={f.filename} className="inline-flex items-center gap-1 text-xs">
            {f.contentType.startsWith("image/") ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/receipts/file/${f.id}`} alt={f.filename} className="h-10 w-10 border border-border object-cover" />
            ) : (
              <span className="border border-border px-1.5 py-2">PDF</span>
            )}
          </a>
          {admin && (
            <form action={deleteExpenseFile}>
              <input type="hidden" name="id" value={f.id} />
              <SubmitButton variant="ghost" size="sm" confirm={`Delete ${f.filename}?`}>
                ×
              </SubmitButton>
            </form>
          )}
        </span>
      ))}
    </span>
  );
}

/**
 * A list of expenses with their receipts. "admin" can approve, reimburse, edit and delete; "member"
 * sees their own and can withdraw pending ones; "readonly" (a linked band account) just looks.
 */
export function ExpenseTable({
  rows,
  files,
  personName,
  bandName,
  projectName,
  mode,
  edit,
  userId,
}: {
  rows: Expense[];
  files: Map<number, ReceiptFile[]>;
  personName: (id: number) => string | undefined;
  bandName: (id: number) => string | undefined;
  /** Shows the project an expense belongs to (linked), when given. */
  projectName?: (id: number) => string | undefined;
  mode: "admin" | "member" | "readonly";
  /** Admin: the edit form for an expense. */
  edit?: (e: Expense) => React.ReactNode;
  userId?: string;
}) {
  if (!rows.length) return <Empty>No expenses yet.</Empty>;
  return (
    <ul className="divide-y divide-border border-y border-border">
      {rows.map((e) => (
        <li key={e.id} className="grid gap-2 py-3 sm:grid-cols-[6rem_minmax(0,1fr)_auto]">
          <span className="text-sm text-muted">{e.date}</span>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{e.description}</span>
              {e.vendor && <span className="text-sm text-muted">· {e.vendor}</span>}
              {e.category && <span className="text-sm text-muted">· {e.category}</span>}
              {e.projectId && projectName?.(e.projectId) && (
                <span className="text-sm text-muted">
                  · {mode === "admin" ? <Link href={`/projects/${e.projectId}`}>{projectName(e.projectId)}</Link> : projectName(e.projectId)}
                </span>
              )}
              {e.bandId && <span className="text-sm text-muted">· {bandName(e.bandId)}</span>}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <Badge tone={STATUS[e.status].tone}>{STATUS[e.status].label}</Badge>
              <span>{coverageText(e, personName)}</span>
              {owedReimbursement(e) && <Badge tone="warn">not reimbursed yet</Badge>}
              {e.reimbursedAt && <Badge tone="good">reimbursed {e.reimbursedAt.slice(0, 10)}</Badge>}
              {e.reviewNote && <span>“{e.reviewNote}”</span>}
            </div>
            <Files files={files.get(e.id) ?? []} admin={mode === "admin"} />

            {mode === "admin" && e.status === "pending" && (
              <form action={reviewExpense} className="flex flex-wrap items-center gap-2 pt-1">
                <input type="hidden" name="id" value={e.id} />
                <label className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" name="recoup" disabled={!e.bandId} /> pay it back from {e.bandId ? `${bandName(e.bandId)}’s` : "band"} sales
                </label>
                <input name="note" placeholder="Note (optional)" className="!w-48 !py-1 !text-xs" />
                <SubmitButton size="sm" name="decision" value="approve">
                  Approve
                </SubmitButton>
                <SubmitButton size="sm" variant="ghost" name="decision" value="reject">
                  Reject
                </SubmitButton>
              </form>
            )}
            {mode === "admin" && e.status === "approved" && e.paidBy === "person" && !e.recoup && (
              <form action={setReimbursed} className="flex flex-wrap items-center gap-2 pt-1">
                <input type="hidden" name="id" value={e.id} />
                <input type="hidden" name="reimbursed" value={e.reimbursedAt ? "false" : "true"} />
                {!e.reimbursedAt && <input name="reference" placeholder="PayPal txn ID (optional)" className="!w-48 !py-1 !text-xs" />}
                <SubmitButton size="sm" variant={e.reimbursedAt ? "ghost" : "secondary"}>
                  {e.reimbursedAt ? "Undo reimbursed" : `Mark ${personName(e.paidByPersonId ?? 0) ?? "them"} reimbursed`}
                </SubmitButton>
              </form>
            )}
            {mode === "admin" && edit && (
              <div className="flex flex-wrap items-start gap-2 pt-1">
                <Disclosure summary="Edit">{edit(e)}</Disclosure>
                <form action={deleteExpense}>
                  <input type="hidden" name="id" value={e.id} />
                  <SubmitButton size="sm" variant="ghost" confirm={`Delete “${e.description}” and its receipts?`}>
                    Delete
                  </SubmitButton>
                </form>
              </div>
            )}
            {mode === "member" && e.status === "pending" && e.submittedByUserId === userId && (
              <form action={deleteExpense}>
                <input type="hidden" name="id" value={e.id} />
                <SubmitButton size="sm" variant="ghost" confirm="Withdraw this receipt?">
                  Withdraw
                </SubmitButton>
              </form>
            )}
          </div>
          <span className="text-right font-medium tabular-nums">
            <Money cents={e.amountCents} currency={e.currency} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Totals for a list of approved expenses, per currency. */
export function expenseTotals(rows: Expense[]) {
  const m = new Map<string, number>();
  for (const e of rows) if (e.status === "approved") m.set(e.currency, (m.get(e.currency) ?? 0) + e.amountCents);
  return m;
}

export function ReceiptsLink({ bandId }: { bandId?: number }) {
  return <Link href={bandId ? `/receipts?band=${bandId}` : "/receipts"}>All receipts</Link>;
}
