import { and, desc, eq, isNull } from "drizzle-orm";
import { connection } from "next/server";
import { SubmitButton } from "@/components/client";
import { SalesSection } from "@/components/sales-section";
import { ExpenseTable, SubmitReceiptForm } from "@/components/receipts";
import { Badge, Callout, Card, Disclosure, Empty, Money, MoneyList, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { linkMyself } from "@/server/account-actions";
import { getContext } from "@/server/context";
import { computePayoutPeriod, nameMaps } from "@/server/data";
import { expenseFileList } from "@/server/expenses";
import { accountProjects } from "@/server/projects";

const STATUS = {
  pending: { label: "To be paid", tone: "warn" },
  paid: { label: "Paid", tone: "good" },
  kept: { label: "Kept in label account", tone: "good" },
} as const;

/**
 * What a member sees: their own payouts (paid and to come), what they've earned since the last
 * payout, and their bands' sales totals. Nobody else's amounts.
 */
export default async function MyEarningsPage({ searchParams }: PageProps<"/me">) {
  await connection();
  const ctx = await getContext();
  const { orgId, person } = ctx;

  if (!person) {
    const unlinked = ctx.isAdmin
      ? await db
          .select()
          .from(schema.people)
          .where(and(eq(schema.people.orgId, orgId), isNull(schema.people.userId)))
          .orderBy(schema.people.name)
      : [];
    return (
      <>
        <PageHeader title="My earnings" />
        <Card>
          <p className="text-sm text-muted">
            Your login isn’t linked to anyone who gets paid in {ctx.org.name} yet.
            {!ctx.isAdmin && " Ask an admin of this account to invite you as the right person."}
          </p>
          {ctx.isAdmin && unlinked.length > 0 && (
            <form action={linkMyself} className="mt-4 flex flex-wrap items-center gap-2">
              <select name="personId" required defaultValue="" className="!w-64" aria-label="Which person are you">
                <option value="" disabled>
                  I’m…
                </option>
                {unlinked.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <SubmitButton variant="secondary">That’s me</SubmitButton>
            </form>
          )}
        </Card>
      </>
    );
  }

  const [payoutRows, myBands, names, unpaid, expenseRows, files] = await Promise.all([
    db
      .select({ payout: schema.payouts, period: schema.periods })
      .from(schema.payouts)
      .innerJoin(schema.periods, eq(schema.periods.id, schema.payouts.periodId))
      .where(and(eq(schema.payouts.orgId, orgId), eq(schema.payouts.personId, person.id)))
      .orderBy(desc(schema.periods.endDate)),
    db
      .select({ band: schema.bands })
      .from(schema.bandMemberships)
      .innerJoin(schema.bands, eq(schema.bands.id, schema.bandMemberships.bandId))
      .where(and(eq(schema.bandMemberships.orgId, orgId), eq(schema.bandMemberships.personId, person.id), eq(schema.bandMemberships.active, true))),
    nameMaps(orgId),
    // Sales no finalized payout has covered yet: what they've earned since the last one.
    computePayoutPeriod(orgId, { id: 0, bandId: null, startDate: "0000-01-01", endDate: "9999-12-31" }),
    db.select().from(schema.expenses).where(eq(schema.expenses.orgId, orgId)).orderBy(desc(schema.expenses.date)),
    expenseFileList(orgId),
  ]);
  // Their receipts: ones they submitted, or paid for.
  const myExpenses = expenseRows.filter((e) => e.submittedByUserId === ctx.user.id || e.paidByPersonId === person.id);

  const owed = new Map<string, number>();
  const received = new Map<string, number>();
  for (const { payout } of payoutRows) {
    const m = payout.status === "pending" ? owed : received;
    m.set(payout.currency, (m.get(payout.currency) ?? 0) + payout.amountCents);
  }
  const upcoming = unpaid.summary.currencies
    .map((cur) => ({ cur, line: unpaid.summary.byCurrency[cur].byPerson.get(person.id) }))
    .filter((x) => x.line && x.line.total !== 0);
  const range = (await searchParams).range as string | undefined;

  return (
    <>
      <PageHeader title="My earnings" subtitle={`${person.name} · ${ctx.org.name}`} />

      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="Waiting to be paid" totals={owed} emphasis />
        <Stat label="Received so far" totals={received} />
        <Stat label="Earned since the last payout" totals={new Map(upcoming.map((u) => [u.cur, u.line!.total]))} />
      </div>
      {upcoming.length > 0 && (
        <Callout tone="neutral">
          Not in a payout yet:{" "}
          {upcoming.map((u, i) => (
            <span key={u.cur}>
              {i > 0 && "; "}
              {[...u.line!.byBand].map(([b, cents], j) => (
                <span key={b}>
                  {j > 0 && ", "}
                  {names.band.get(b)} <Money cents={cents} currency={u.cur} />
                </span>
              ))}
            </span>
          ))}
          . It’ll be included the next time {ctx.org.name} pays out.
        </Callout>
      )}

      <Card title="Payouts">
        {payoutRows.length === 0 ? (
          <Empty>No payouts yet.</Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Payout</th>
                <th>From</th>
                <th className="num">Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {payoutRows.map(({ payout, period }) => (
                <tr key={payout.id}>
                  <td>
                    <div className="font-medium">{period.name}</div>
                    <div className="text-xs text-muted">
                      {period.startDate} → {period.endDate}
                    </div>
                  </td>
                  <td className="text-xs">
                    {Object.entries(payout.byBand).map(([b, cents]) => (
                      <div key={b}>
                        {names.band.get(Number(b))}: <Money cents={cents} currency={payout.currency} />
                      </div>
                    ))}
                  </td>
                  <td className="num font-medium">
                    <Money cents={payout.amountCents} currency={payout.currency} />
                  </td>
                  <td>
                    <Badge tone={STATUS[payout.status].tone}>{STATUS[payout.status].label}</Badge>
                    {payout.paidAt && payout.status === "paid" && <div className="mt-1 text-xs text-muted">{payout.paidAt.slice(0, 10)}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="My receipts">
        <p className="mb-3 text-sm text-muted">
          Paid for something for a band? Submit the receipt. Once an admin approves it, you’re paid back, either from the band’s
          sales in your next payout or directly by the label.
        </p>
        <div className="mb-4">
          <Disclosure summary="+ Submit a receipt">
            <SubmitReceiptForm
              bands={myBands.map(({ band }) => band)}
              projects={(await accountProjects(orgId)).filter((p) => myBands.some(({ band }) => band.id === p.bandId) && p.status !== "done")}
            />
          </Disclosure>
        </div>
        <ExpenseTable
          rows={myExpenses}
          files={files}
          personName={(id) => (id === person.id ? "you" : names.person.get(id))}
          bandName={(id) => names.band.get(id)}
          mode="member"
          userId={ctx.user.id}
        />
      </Card>

      {myBands.map(({ band }) => (
        <SalesSection key={band.id} boardId="member-sales" scope={{ bandId: band.id }} range={range} basePath="/me" readOnly title={`${band.name} sales`} />
      ))}
    </>
  );
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
