import { and, desc, eq, isNull } from "drizzle-orm";
import { EarningsStats } from "@/components/earnings-stats";
import { connection } from "next/server";
import { SubmitButton } from "@/components/client";
import { SalesSection } from "@/components/sales-section";
import { ExpenseTable, SubmitReceiptForm } from "@/components/receipts";
import Link from "next/link";
import { Badge, buttonClass, Callout, Card, Disclosure, Empty, Money, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { linkMyself } from "@/server/account-actions";
import { type Context, getContext, ownBooksOf } from "@/server/context";
import { projectsEnabled } from "@/server/features";
import { computePayoutPeriod, nameMaps, ownBand } from "@/server/data";
import { addTotals, earningsIn } from "@/server/earnings";
import { expenseFileList } from "@/server/expenses";
import { accountProjects } from "@/server/projects";

export const metadata = { title: "my earnings" };

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
  // A band account the label made: from the label and from the band's own books, together.
  if (ctx.managedBy) return <BandAccountEarnings ctx={ctx} range={(await searchParams).range as string | undefined} />;
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
            Your account isn’t linked to anyone who gets paid in {ctx.org.name} yet.
            {!ctx.isAdmin && " Ask an admin of this group to invite you as the right person."}
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
      <PageHeader title="My earnings" subtitle={`${person.name} · ${ctx.org.name}`} actions={myBands.length > 0 && <AddSale />} />

      <div className="mb-8">
        <EarningsStats owed={owed} received={received} upcoming={new Map(upcoming.map((u) => [u.cur, u.line!.total]))} />
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
          <div className="overflow-x-auto">
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
          </div>
        )}
      </Card>

      <Card title="My receipts">
        {/* <p className="mb-3 text-sm text-muted">
          Paid for something for a band? Submit the receipt. Once an admin approves it, you’re paid back, either from the band’s
          sales in your next payout or directly by the label.
        </p> */}
        <div className="mb-4">
          <Disclosure summary="+ Submit a receipt">
            <SubmitReceiptForm
              bands={myBands.map(({ band }) => band)}
              projects={(!(await projectsEnabled()) ? [] : await accountProjects(orgId)).filter((p) => myBands.some(({ band }) => band.id === p.bandId) && p.status !== "done")}
            />
          </Disclosure>
        </div>
        <ExpenseTable
          group={ctx.org.kind === "band" ? "band" : "label"}
          groupName={ctx.org.name}
          rows={myExpenses}
          files={files}
          personName={(id) => (id === person.id ? "you" : names.person.get(id))}
          bandName={(id) => names.band.get(id)}
          mode="member"
          userId={ctx.user.id}
        />
      </Card>

      {myBands.map(({ band }) => (
        <SalesSection key={band.id} boardId="member-sales" scope={{ bandId: band.id }} range={range} basePath="/me" readOnly hideMoneyWent title={`${band.name} sales`} />
      ))}
    </>
  );
}

/** Any band member can add a sale by hand (a show, merch sold in person). */
function AddSale() {
  return (
    <Link href="/sales/add" className={buttonClass("secondary")}>
      Add a sale
    </Link>
  );
}

/**
 * A member of a band account the label made: their earnings from the label (just this band's part)
 * and from the band's own books, in one place, with the label's marked "through {label}".
 */
async function BandAccountEarnings({ ctx, range }: { ctx: Context; range?: string }) {
  const m = ctx.managedBy!;
  const own = await ownBooksOf(ctx);
  // Who they are in each set of books (a member's own account; the band's shared one is nobody).
  const labelPerson = ctx.person;
  const ownPerson = own.person;
  if (!labelPerson && !ownPerson) {
    return (
      <>
        <PageHeader title="My earnings" />
        <Card>
          <p className="text-sm text-muted">Your account isn’t linked to anyone who gets paid in {ctx.org.name} yet.</p>
        </Card>
      </>
    );
  }
  const projectsOn = await projectsEnabled();
  const [fromLabel, fromOwn, labelNames, ownNames, labelExpenses, ownExpenses, labelFiles, ownFiles, labelProjects, ownProjects, band] = await Promise.all([
    labelPerson ? earningsIn(m.labelOrgId, labelPerson.id, m.bandId) : null,
    ownPerson ? earningsIn(own.orgId, ownPerson.id) : null,
    nameMaps(m.labelOrgId),
    nameMaps(own.orgId),
    db.select().from(schema.expenses).where(and(eq(schema.expenses.orgId, m.labelOrgId), eq(schema.expenses.bandId, m.bandId))).orderBy(desc(schema.expenses.date)),
    db.select().from(schema.expenses).where(eq(schema.expenses.orgId, own.orgId)).orderBy(desc(schema.expenses.date)),
    expenseFileList(m.labelOrgId),
    expenseFileList(own.orgId),
    projectsOn ? accountProjects(m.labelOrgId) : [],
    projectsOn ? accountProjects(own.orgId) : [],
    ownBand(own.orgId),
  ]);
  const none = { lines: [], owed: new Map(), received: new Map(), upcoming: [] };
  const l = fromLabel ?? none;
  const o = fromOwn ?? none;
  const upcoming = addTotals(new Map(l.upcoming.map((u) => [u.cur, u.line.total])), new Map(o.upcoming.map((u) => [u.cur, u.line.total])));
  const payouts = [
    ...l.lines.map((x) => ({ ...x, through: m.labelName as string | null })),
    ...o.lines.map((x) => ({ ...x, through: null as string | null })),
  ].sort((a, b) => b.period.endDate.localeCompare(a.period.endDate));
  // Their receipts: ones they sent in, or paid for.
  const mine = (e: typeof ownExpenses[number], person: typeof ownPerson) => e.submittedByUserId === ctx.user.id || (!!person && e.paidByPersonId === person.id);
  const receipts = [...ownExpenses.filter((e) => mine(e, ownPerson)), ...labelExpenses.filter((e) => mine(e, labelPerson))].sort(
    (a, b) => b.date.localeCompare(a.date) || b.id - a.id,
  );
  const name = (labelPerson ?? ownPerson)!.name;

  return (
    <>
      <PageHeader title="My earnings" subtitle={`${name} · ${ctx.org.name}`} actions={<AddSale />} />

      <div className="mb-8">
        <EarningsStats owed={addTotals(l.owed, o.owed)} received={addTotals(l.received, o.received)} upcoming={upcoming} />
      </div>

      <Card title="Payouts">
        {payouts.length === 0 ? (
          <Empty>No payouts yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
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
                {payouts.map(({ payout, period, cents, through }) => (
                  <tr key={payout.id}>
                    <td>
                      <div className="font-medium">{period.name}</div>
                      <div className="text-xs text-muted">
                        {period.startDate} → {period.endDate}
                      </div>
                    </td>
                    <td className="text-xs">{through ? `through ${through}` : ctx.org.name}</td>
                    <td className="num font-medium">
                      <Money cents={cents} currency={payout.currency} />
                    </td>
                    <td>
                      <Badge tone={STATUS[payout.status].tone}>{STATUS[payout.status].label}</Badge>
                      {payout.paidAt && payout.status === "paid" && <div className="mt-1 text-xs text-muted">{payout.paidAt.slice(0, 10)}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="My receipts">
        {/* One form: whoever pays it back (the band, or the label) says whose books it goes in. */}
        {ownPerson && band && labelPerson && (
          <div className="mb-4">
            <Disclosure summary="+ Submit a receipt">
              <SubmitReceiptForm oneBand bands={[band]} paidBackBy={{ own: ctx.org.name, label: m.labelName }} />
            </Disclosure>
          </div>
        )}
        {ownPerson && band && !labelPerson && (
          <div className="mb-4">
            <Disclosure summary="+ Submit a receipt">
              <SubmitReceiptForm oneBand bands={[band]} projects={ownProjects.filter((p) => p.status !== "done")} />
            </Disclosure>
          </div>
        )}
        {labelPerson && !(ownPerson && band) && (
          <div className="mb-4">
            <Disclosure summary="+ Submit a receipt">
              <SubmitReceiptForm
                oneBand
                toLabel
                bands={[{ id: m.bandId, name: ctx.org.name }]}
                projects={labelProjects.filter((p) => p.bandId === m.bandId && p.status !== "done")}
              />
            </Disclosure>
          </div>
        )}
        <ExpenseTable
          group="band"
          groupName={ctx.org.name}
          rows={receipts}
          files={new Map([...ownFiles, ...labelFiles])}
          personName={(id) => (id === labelPerson?.id || id === ownPerson?.id ? "you" : (labelNames.person.get(id) ?? ownNames.person.get(id)))}
          bandName={() => ctx.org.name}
          mode="member"
          userId={ctx.user.id}
          through={(e) => (e.orgId === m.labelOrgId ? m.labelName : undefined)}
        />
      </Card>

      {/* The band's sales, its own and through the label, as one. */}
      <SalesSection
        boardId="member-sales"
        scope={{}}
        books={[...(band ? [{ orgId: own.orgId, bandId: band.id }] : []), { orgId: m.labelOrgId, bandId: m.bandId }]}
        range={range}
        basePath="/me"
        readOnly
        hideMoneyWent
        title={`${ctx.org.name} sales`}
      />
    </>
  );
}
