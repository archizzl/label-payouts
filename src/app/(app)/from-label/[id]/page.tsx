import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { ExpenseTable, expenseTotals } from "@/components/receipts";
import { SalesSection } from "@/components/sales-section";
import { Badge, Callout, Card, Empty, Money, MoneyList, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/status";
import { computePayoutPeriod, nameMaps } from "@/server/data";
import { accountExpenses, expenseFileList } from "@/server/expenses";
import { requireLinkedView } from "@/server/links";
import { projectsEnabled } from "@/server/features";
import { accountProjects, projectNumbers } from "@/server/projects";

export const metadata = { title: "from label" };

const PAYOUT_STATUS = { pending: "to be paid", paid: "paid", kept: "kept by the label account holder" } as const;

/**
 * A band account's read-only view of its label's books for that band: sales through the label,
 * where the money went, payouts to its members, statements and receipts. Nothing here can be changed.
 */
export default async function FromLabelPage({ params, searchParams }: PageProps<"/from-label/[id]">) {
  await connection();
  const linkId = Number((await params).id);
  const v = await requireLinkedView(linkId);
  const { labelOrgId, bandId } = v;
  const showProjects = await projectsEnabled();
  const [periods, names, expenses, files, labelProjects, projectTotals] = await Promise.all([
    db
      .select()
      .from(schema.periods)
      .where(and(eq(schema.periods.orgId, labelOrgId), or(eq(schema.periods.bandId, bandId), isNull(schema.periods.bandId))))
      .orderBy(desc(schema.periods.endDate)),
    nameMaps(labelOrgId),
    accountExpenses(labelOrgId, { bandId }),
    expenseFileList(labelOrgId),
    showProjects ? accountProjects(labelOrgId) : [],
    showProjects ? projectNumbers(labelOrgId) : new Map<number, never>(),
  ]);
  const bandProjects = labelProjects.filter((p) => p.bandId === bandId);
  const mine = await myEarnings(labelOrgId, bandId, v.ctx.user.email);
  const payoutRows = periods.length
    ? await db
        .select()
        .from(schema.payouts)
        .where(
          and(
            eq(schema.payouts.orgId, labelOrgId),
            inArray(
              schema.payouts.periodId,
              periods.map((p) => p.id),
            ),
          ),
        )
    : [];
  // Only this band's part of each payout: whole-label payouts cover other bands too.
  const payoutsFor = (periodId: number) =>
    payoutRows
      .filter((p) => p.periodId === periodId && (p.byBand[String(bandId)] ?? 0) !== 0)
      .map((p) => ({ ...p, cents: p.byBand[String(bandId)] }));
  const paidPeriods = periods.filter((p) => payoutsFor(p.id).length > 0);
  const approved = expenses.filter((e) => e.status === "approved");

  return (
    <>
      <PageHeader title={`${v.bandName} on ${v.labelName}`} subtitle="From the label’s books, read-only." />
      <Callout tone="neutral">
        This is what {v.labelName} records for {v.bandName}. Only the label can change it; ask them if something looks wrong.
      </Callout>

      {mine && (
        <Card title={`Your earnings from ${v.labelName}`}>
          <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Stat label="Waiting to be paid" totals={mine.owed} emphasis />
            <Stat label="Received so far" totals={mine.received} />
            <Stat label="Earned since the last payout" totals={mine.upcoming} />
          </div>
          <p className="text-xs text-muted">
            As {mine.person.name} in {v.labelName}’s books, across every band you’re in there.
          </p>
        </Card>
      )}

      <SalesSection
        boardId="label-sales"
        orgId={labelOrgId}
        scope={{ bandId }}
        range={(await searchParams).range as string | undefined}
        basePath={`/from-label/${linkId}`}
        readOnly
        showItems
        title="Sales through the label"
      />

      <Card title="Payouts">
        {paidPeriods.length === 0 ? (
          <Empty>No payouts for {v.bandName} yet.</Empty>
        ) : (
          <ul className="space-y-5">
            {paidPeriods.map((p) => {
              const lines = payoutsFor(p.id);
              const totals = new Map<string, number>();
              for (const l of lines) totals.set(l.currency, (totals.get(l.currency) ?? 0) + l.cents);
              return (
                <li key={p.id}>
                  <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-medium">{p.name}</span>
                    <span className="text-sm text-muted">
                      {p.startDate} → {p.endDate}
                    </span>
                    <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
                    <span className="ml-auto text-sm">
                      <MoneyList totals={totals} /> to members ·{" "}
                      <Link href={`/from-label/${linkId}/statement/${p.id}`}>statement</Link>
                    </span>
                  </div>
                  <table className="data">
                    <tbody>
                      {lines.map((l) => (
                        <tr key={l.id}>
                          <td>{names.person.get(l.personId)}</td>
                          <td className="text-sm text-muted">{PAYOUT_STATUS[l.status]}</td>
                          <td className="num">
                            <Money cents={l.cents} currency={l.currency} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {bandProjects.length > 0 && (
        <Card title="Projects">
          <table className="data">
            <thead>
              <tr>
                <th>Project</th>
                <th className="num">Spent</th>
                <th className="num">Made back</th>
                <th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              {bandProjects.map((p) => {
                const t = projectTotals.get(p.id)!;
                return (
                  <tr key={p.id}>
                    <td>
                      {p.name}
                      {p.status === "done" && <span className="ml-2 text-xs text-muted">done</span>}
                    </td>
                    <td className="num">
                      <Money cents={t.spent} currency={t.currency} />
                    </td>
                    <td className="num">
                      <Money cents={t.madeBack} currency={t.currency} />
                    </td>
                    <td className="num">
                      <Money cents={t.balance} currency={t.currency} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      <Card title="Receipts">
        {approved.length > 0 && (
          <p className="mb-3 text-sm text-muted">
            Approved expenses for {v.bandName}: <MoneyList totals={expenseTotals(approved)} />
          </p>
        )}
        <ExpenseTable
          rows={expenses.filter((e) => e.status !== "rejected")}
          files={files}
          personName={(id) => names.person.get(id)}
          bandName={(id) => names.band.get(id)}
          projectName={(pid) => labelProjects.find((p) => p.id === pid)?.name}
          mode="readonly"
        />
      </Card>
    </>
  );
}

/**
 * The signed-in person's own earnings in the label's books: the label's payee in this band with
 * their email. Null if there isn't one (or for a label admin viewing as the band).
 */
async function myEarnings(labelOrgId: string, bandId: number, email: string) {
  if (!email) return null;
  const [person] = (
    await db
      .select({ person: schema.people })
      .from(schema.bandMemberships)
      .innerJoin(schema.people, eq(schema.people.id, schema.bandMemberships.personId))
      .where(and(eq(schema.bandMemberships.orgId, labelOrgId), eq(schema.bandMemberships.bandId, bandId)))
  )
    .map((r) => r.person)
    .filter((p) => p.email?.trim().toLowerCase() === email.trim().toLowerCase());
  if (!person) return null;
  const [payoutRows, unpaid] = await Promise.all([
    db
      .select()
      .from(schema.payouts)
      .where(and(eq(schema.payouts.orgId, labelOrgId), eq(schema.payouts.personId, person.id))),
    computePayoutPeriod(labelOrgId, { id: 0, bandId: null, startDate: "0000-01-01", endDate: "9999-12-31" }),
  ]);
  const owed = new Map<string, number>();
  const received = new Map<string, number>();
  for (const p of payoutRows) {
    const m = p.status === "pending" ? owed : received;
    m.set(p.currency, (m.get(p.currency) ?? 0) + p.amountCents);
  }
  const upcoming = new Map<string, number>();
  for (const cur of unpaid.summary.currencies) {
    const line = unpaid.summary.byCurrency[cur].byPerson.get(person.id);
    if (line?.total) upcoming.set(cur, line.total);
  }
  return { person, owed, received, upcoming };
}

function Stat({ label, totals, emphasis }: { label: string; totals: Map<string, number>; emphasis?: boolean }) {
  return (
    <div className={`border-l-2 pl-3 ${emphasis ? "border-accent" : "border-border"}`}>
      <div className="text-xs text-muted lowercase">{label}</div>
      <div className={`mt-0.5 text-xl font-bold ${emphasis ? "text-accent" : ""}`}>
        {totals.size ? <MoneyList totals={totals} /> : <Money cents={0} />}
      </div>
    </div>
  );
}
