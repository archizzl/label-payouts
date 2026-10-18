import { asc, eq } from "drizzle-orm";
import { BandFilter } from "@/components/band-filter";
import { connection } from "next/server";
import { ExpenseForm, ExpenseTable, expenseTotals, SubmitReceiptForm } from "@/components/receipts";
import { bandMembers } from "@/server/band-member";
import { Card, Disclosure, MoneyList, PageHeader } from "@/components/ui";
import { formatMegabytes, RECEIPT_SPACE_BYTES } from "@/lib/receipt-space";
import { receiptBytesUsed } from "@/server/receipt-store";
import { db, schema } from "@/db";
import { ClearFilesPart } from "@/components/receipt-cleanup";
import { bandScope, can, inBandScope } from "@/lib/permissions";
import { getContext, requireAccess } from "@/server/context";
import { projectsEnabled } from "@/server/features";
import { clearableFiles } from "@/server/receipt-cleanup";
import { accountExpenses, expenseFileList, owedReimbursement } from "@/server/expenses";
import { accountProjects } from "@/server/projects";

export const metadata = { title: "receipts" };

/** Every expense and its receipts: what's waiting for approval first, then everything else. */
export default async function ReceiptsPage({ searchParams }: PageProps<"/receipts">) {
  await connection();
  const ctx = await requireAccess("receipts");
  const { orgId, access, person, user, managedBy: m } = ctx;
  // A band account the label made: its own receipts, and the ones sent to the label for it (the
  // label's to approve and pay back), in one list.
  const lens = m ? await getContext() : null;
  const canChange = can(access, "receipts", "edit");
  // Limited to their own bands: only those bands' receipts (not label-wide ones).
  const scope = bandScope(access, "receipts");
  const sp = await searchParams;
  const bandFilter = m ? undefined : Number(sp.band) || undefined;
  // Just the receipts they paid for or sent in (for someone who gets paid here).
  const mineOnly = !!person && sp.mine === "1";
  const [all, files, bands, releases, people, projects, clearable, spaceUsed] = await Promise.all([
    accountExpenses(orgId, bandFilter ? { bandId: bandFilter } : undefined),
    expenseFileList(orgId),
    db.select().from(schema.bands).where(eq(schema.bands.orgId, orgId)).orderBy(asc(schema.bands.name)),
    db.select().from(schema.releases).where(eq(schema.releases.orgId, orgId)).orderBy(asc(schema.releases.title)),
    db.select().from(schema.people).where(eq(schema.people.orgId, orgId)).orderBy(asc(schema.people.name)),
    projectsEnabled().then((on) => (on ? accountProjects(orgId) : [])),
    canChange && !scope ? clearableFiles(orgId) : null,
    canChange && !scope ? receiptBytesUsed(orgId) : null,
  ]);
  const [labelRows, labelFiles, labelPeople, labelProjects] = m
    ? await Promise.all([
        accountExpenses(m.labelOrgId, { bandId: m.bandId }),
        expenseFileList(m.labelOrgId),
        db.select({ id: schema.people.id, name: schema.people.name }).from(schema.people).where(eq(schema.people.orgId, m.labelOrgId)),
        projectsEnabled().then((on) => (on ? accountProjects(m.labelOrgId) : [])),
      ])
    : [[], new Map(), [], []];
  const throughLabel = (e: (typeof all)[number]) => (m && e.orgId === m.labelOrgId ? m.labelName : undefined);
  // A band's shared login sends nothing in itself: "mine" is whoever's using it.
  const isMine = (e: (typeof all)[number]) =>
    throughLabel(e) ? !!lens?.person && e.paidByPersonId === lens.person.id : e.paidByPersonId === person?.id || (!m && e.submittedByUserId === user.id);
  const visible = [...(scope ? all.filter((e) => inBandScope(scope, [e.bandId])) : all), ...labelRows.filter((e) => e.status !== "rejected")]
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
    .filter((e) => !mineOnly || isMine(e));
  const allFiles = m ? new Map([...files, ...labelFiles]) : files;
  const bandsShown = scope ? bands.filter((b) => scope.includes(b.id)) : bands;
  const projectName = (pid: number) => [...projects, ...labelProjects].find((p) => p.id === pid)?.name;
  const personName = (id: number) => [...people, ...labelPeople].find((p) => p.id === id)?.name;
  // (A band account's receipts are all its band's, through the label or not.)
  const bandName = (id: number) => bands.find((b) => b.id === id)?.name ?? (m ? ctx.org.name : undefined);
  const payees = new Map(people.map((p) => [p.id, p]));
  const pending = visible.filter((e) => e.status === "pending");
  const rest = visible.filter((e) => e.status !== "pending");
  const owed = visible.filter(owedReimbursement);
  const recouping = visible.filter((e) => e.status === "approved" && e.recoup);
  const form = (e?: (typeof all)[number]) => (
    <ExpenseForm expense={e} bands={bandsShown} releases={releases} people={people} bandId={bandFilter} projects={projects} oneBand={ctx.org.kind === "band"} />
  );
  // Seeing receipts without changing them: no forms, approve or pay-back buttons (just withdrawing your own pending one).
  const tableMode = canChange ? ({ mode: "admin", edit: form } as const) : ({ mode: "member", userId: user.id } as const);

  return (
    <>
      <PageHeader
        title="Receipts"
        subtitle={
          spaceUsed !== null && (
            <span className={spaceUsed > RECEIPT_SPACE_BYTES * 0.9 ? "text-warn" : undefined}>
              {formatMegabytes(spaceUsed)} of {formatMegabytes(RECEIPT_SPACE_BYTES)} used
            </span>
          )
        }
      />
      {/* (Nothing to pick between for a band account's shared login: just everything.) */}
      {(!m || person || lens?.person) && (
        <BandFilter
          path="/receipts"
          bands={m ? [] : bandsShown}
          current={bandFilter}
          all="everything"
          extras={person || lens?.person ? [{ href: "/receipts?mine=1", label: "mine", on: mineOnly }] : []}
        />
      )}

      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="Approved expenses" totals={expenseTotals(rest)} />
        <Stat label="Being paid back from sales" totals={expenseTotals(recouping)} />
        <Stat label="Owed back to people" totals={expenseTotals(owed)} warn={owed.length > 0} />
      </div>

      {pending.length > 0 && (
        <Card title={`Waiting for approval (${pending.length})`}>
          <ExpenseTable rows={pending} files={allFiles} personName={personName} bandName={bandName} projectName={projectName} {...tableMode} userId={user.id} payees={payees} through={throughLabel} group={ctx.org.kind === "band" ? "band" : "label"} />
        </Card>
      )}

      <Card title="Expenses">
        {canChange ? (
          <div className="mb-4">
            <Disclosure summary="+ Add an expense">{form()}</Disclosure>
          </div>
        ) : (
          // Band members send in receipts for an admin to approve.
          person && (
            <div className="mb-4">
              <Disclosure summary="+ Submit a receipt">
                <SubmitReceiptForm
                  oneBand={ctx.org.kind === "band"}
                  bands={bandsShown}
                  projects={projects.filter((p) => p.status !== "done" && bandsShown.some((b) => b.id === p.bandId))}
                />
              </Disclosure>
            </div>
          )
        )}
        {/* A band account the label made: receipts for the label to approve and pay back (the band's shared login says who paid). */}
        {m && lens && (
          <div className="mb-4">
            <Disclosure summary={`+ Send a receipt to ${m.labelName}`}>
              <SubmitReceiptForm
                  oneBand={ctx.org.kind === "band"}
                toLabel
                bands={[{ id: m.bandId, name: ctx.org.name }]}
                projects={labelProjects.filter((p) => p.status !== "done" && p.bandId === m.bandId)}
                payers={lens.person ? undefined : await bandMembers(m.labelOrgId, m.bandId)}
              />
            </Disclosure>
          </div>
        )}
        <ExpenseTable rows={rest} files={allFiles} personName={personName} bandName={bandName} projectName={projectName} {...tableMode} userId={user.id} payees={payees} through={throughLabel} group={ctx.org.kind === "band" ? "band" : "label"} />
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
