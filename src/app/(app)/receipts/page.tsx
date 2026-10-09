import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { ExpenseForm, ExpenseTable, expenseTotals } from "@/components/receipts";
import { Card, Disclosure, MoneyList, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { ClearFilesPart } from "@/components/receipt-cleanup";
import { can } from "@/lib/permissions";
import { requireAccess } from "@/server/context";
import { clearableFiles } from "@/server/receipt-cleanup";
import { accountExpenses, expenseFileList, owedReimbursement } from "@/server/expenses";
import { accountProjects } from "@/server/projects";

/** Every expense and its receipts: what's waiting for approval first, then everything else. */
export default async function ReceiptsPage({ searchParams }: PageProps<"/receipts">) {
  await connection();
  const { orgId, access } = await requireAccess("receipts");
  const canChange = can(access, "receipts", "edit");
  const bandFilter = Number((await searchParams).band) || undefined;
  const [all, files, bands, releases, people, projects, clearable] = await Promise.all([
    accountExpenses(orgId, bandFilter ? { bandId: bandFilter } : undefined),
    expenseFileList(orgId),
    db.select().from(schema.bands).where(eq(schema.bands.orgId, orgId)).orderBy(asc(schema.bands.name)),
    db.select().from(schema.releases).where(eq(schema.releases.orgId, orgId)).orderBy(asc(schema.releases.title)),
    db.select().from(schema.people).where(eq(schema.people.orgId, orgId)).orderBy(asc(schema.people.name)),
    accountProjects(orgId),
    canChange ? clearableFiles(orgId) : null,
  ]);
  const projectName = (pid: number) => projects.find((p) => p.id === pid)?.name;
  const personName = (id: number) => people.find((p) => p.id === id)?.name;
  const bandName = (id: number) => bands.find((b) => b.id === id)?.name;
  const payees = new Map(people.map((p) => [p.id, p]));
  const pending = all.filter((e) => e.status === "pending");
  const rest = all.filter((e) => e.status !== "pending");
  const owed = all.filter(owedReimbursement);
  const recouping = all.filter((e) => e.status === "approved" && e.recoup);
  const form = (e?: (typeof all)[number]) => (
    <ExpenseForm expense={e} bands={bands} releases={releases} people={people} bandId={bandFilter} projects={projects} />
  );

  return (
    <>
      <PageHeader
        title="Receipts"
        subtitle="Expenses and their receipts: who paid, and whether sales pay them back. Members can submit their own from My earnings."
      />
      <nav className="mb-6 flex flex-wrap gap-2 text-sm">
        <Link href="/receipts" className={`rounded-full px-3 py-1 ${!bandFilter ? "bg-text text-bg" : "bg-surface-2 text-muted"}`}>
          everything
        </Link>
        {bands.map((b) => (
          <Link key={b.id} href={`/receipts?band=${b.id}`} className={`rounded-full px-3 py-1 ${bandFilter === b.id ? "bg-text text-bg" : "bg-surface-2 text-muted"}`}>
            {b.name}
          </Link>
        ))}
      </nav>

      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="Approved expenses" totals={expenseTotals(rest)} />
        <Stat label="Being paid back from sales" totals={expenseTotals(recouping)} />
        <Stat label="Owed back to people" totals={expenseTotals(owed)} warn={owed.length > 0} />
      </div>

      {pending.length > 0 && (
        <Card title={`Waiting for approval (${pending.length})`}>
          <ExpenseTable rows={pending} files={files} personName={personName} bandName={bandName} projectName={projectName} mode="admin" edit={form} payees={payees} />
        </Card>
      )}

      <Card title="Expenses">
        <div className="mb-4">
          <Disclosure summary="+ Add an expense">{form()}</Disclosure>
        </div>
        <ExpenseTable rows={rest} files={files} personName={personName} bandName={bandName} projectName={projectName} mode="admin" edit={form} payees={payees} />
      </Card>

      {clearable && clearable.files.length > 0 && (
        <Card title="Clear out settled receipts’ files">
          <p className="mb-3 text-sm text-muted">
            {clearable.receipts} receipt{clearable.receipts === 1 ? " is" : "s are"} settled: approved, and paid back (or nothing to pay back).
            Download their files to keep, then remove them from storage. The receipts themselves stay.
          </p>
          {clearable.batches.map((b, i) => (
            <ClearFilesPart
              key={b.map((f) => f.id).join(",")}
              label={clearable.batches.length > 1 ? `Part ${i + 1} of ${clearable.batches.length}` : "All of them"}
              ids={b.map((f) => f.id)}
              count={b.length}
              bytes={b.reduce((a, f) => a + f.size, 0)}
              receipts={new Set(b.map((f) => f.expenseId)).size}
            />
          ))}
        </Card>
      )}
    </>
  );
}

function Stat({ label, totals, warn }: { label: string; totals: Map<string, number>; warn?: boolean }) {
  return (
    <div className={`border-l-2 pl-3 ${warn ? "border-warn" : "border-border"}`}>
      <div className="text-xs text-muted lowercase">{label}</div>
      <div className={`mt-0.5 text-xl font-bold ${warn ? "text-warn" : ""}`}>{totals.size ? <MoneyList totals={totals} /> : "—"}</div>
    </div>
  );
}
