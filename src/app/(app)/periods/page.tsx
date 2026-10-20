import { and, asc, desc, eq, isNotNull, max, min, notExists, sql } from "drizzle-orm";
import { BandFilter } from "@/components/band-filter";
import Link from "next/link";
import { connection } from "next/server";
import { ActionForm, SubmitButton } from "@/components/client";
import { ChartBoard } from "@/components/chart-board";
import { owedChart } from "@/components/owed";
import { loadLayout } from "@/server/chart-layouts";
import { Badge, Callout, Card, Disclosure, Empty, Field, Money, MoneyList, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { periodName } from "@/lib/dates";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/status";
import { previewPayout } from "@/server/actions";
import { requireAccess } from "@/server/context";
import { labelPayoutsFor, syncOwnPeople } from "@/server/own-books";
import { owedByBand, owedTotal } from "@/server/owed";

export const metadata = { title: "payouts" };

export default async function PeriodsPage({ searchParams }: PageProps<"/periods">) {
  await connection();
  const ctx = await requireAccess("payouts");
  const { orgId } = ctx;
  // A band account the label made: its own payouts, and the label's that paid its members.
  const m = ctx.managedBy;
  if (m) await syncOwnPeople(orgId);
  const [periods, payouts, bands, [salesRange], fromLabel] = await Promise.all([
    db.select().from(schema.periods).where(eq(schema.periods.orgId, orgId)).orderBy(desc(schema.periods.startDate)),
    db.select().from(schema.payouts).where(eq(schema.payouts.orgId, orgId)),
    db.select().from(schema.bands).where(eq(schema.bands.orgId, orgId)).orderBy(asc(schema.bands.name)),
    db
      .select({ first: min(schema.sales.date), last: max(schema.sales.date) })
      .from(schema.sales)
      .where(eq(schema.sales.orgId, orgId)),
    m ? labelPayoutsFor(m.labelOrgId, m.bandId) : [],
  ]);
  const [owed, owedLayout, labelOwes] = await Promise.all([
    owedChart(orgId),
    loadLayout("payouts"),
    // What the label still owes the band (a band account the label made).
    m ? owedByBand(m.labelOrgId).then((rows) => rows.filter((r) => r.bandId === m.bandId)) : [],
  ]);
  const owesOwn = owed.data.shape === "owed" && owed.data.groups.some((g) => g.grand !== 0);
  const owesFromLabel = new Map(labelOwes.map((r) => [r.currency, owedTotal(r)]).filter(([, c]) => c !== 0) as [string, number][]);
  const bandName = new Map(bands.map((b) => [b.id, b.name]));
  // Who this payout is for: the whole label, or one band (?band=ID).
  const bandParam = Number((await searchParams).band);
  const forBand = bands.find((b) => b.id === bandParam) ?? null;
  // The last finalized payout that covers this choice: for a band, its own or a label-wide one.
  const lastClosed = periods
    .filter((p) => (forBand ? p.bandId === null || p.bandId === forBand.id : p.bandId === null))
    .reduce<string | undefined>((a, p) => (!a || p.endDate > a ? p.endDate : a), undefined);
  // Default to everything not paid yet: from the last finalized payout's end date (or the first
  // sale), up to today. (Local date: the app runs on your machine.)
  const today = new Date().toLocaleDateString("en-CA");
  // The earliest sale with a band that no finalized payout has paid: e.g. a band whose split was
  // set after a payout went ahead without it. The next payout reaches back for it.
  // (Payouts from older books didn't record their sales: they cover everything in their dates.)
  const [unpaid, listed] = await Promise.all([
    db
      .select({ date: schema.sales.date, bandId: schema.sales.bandId })
      .from(schema.sales)
      .where(
        and(
          eq(schema.sales.orgId, orgId),
          forBand ? eq(schema.sales.bandId, forBand.id) : isNotNull(schema.sales.bandId),
          notExists(
            db
              .select({ one: sql`1` })
              .from(schema.periodSales)
              .where(and(eq(schema.periodSales.orgId, orgId), eq(schema.periodSales.dedupeKey, schema.sales.dedupeKey))),
          ),
        ),
      )
      .orderBy(asc(schema.sales.date))
      .limit(500),
    db.selectDistinct({ periodId: schema.periodSales.periodId }).from(schema.periodSales).where(eq(schema.periodSales.orgId, orgId)),
  ]);
  const withList = new Set(listed.map((r) => r.periodId));
  const firstUnpaid = unpaid.find(
    (s) => !periods.some((p) => !withList.has(p.id) && s.date >= p.startDate && s.date <= p.endDate && (p.bandId === null || p.bandId === s.bandId)),
  )?.date;
  const reachesBack = !!(firstUnpaid && lastClosed && firstUnpaid < lastClosed);
  // The day the last payout ended, not the day after: sales later that day weren't in it.
  const defaultStart = (reachesBack ? firstUnpaid : lastClosed) ?? salesRange?.first ?? today;
  // (If the last payout already runs past today, start and end on its last day.)
  const defaultEnd = defaultStart > today ? defaultStart : today;

  // Every finalized payout, newest first: this account's own, and (a band account the label made) the label's that paid its members.
  const totalsOf = (periodId: number) => {
    const byCurrency = new Map<string, { total: number; paid: number }>();
    for (const x of payouts.filter((x) => x.periodId === periodId)) {
      const e = byCurrency.get(x.currency) ?? { total: 0, paid: 0 };
      e.total += x.amountCents;
      if (x.status !== "pending") e.paid += x.amountCents;
      byCurrency.set(x.currency, e);
    }
    return byCurrency;
  };
  const rows = [
    ...periods.map((p) => ({ key: `own-${p.id}`, href: `/periods/${p.id}`, period: p, byCurrency: totalsOf(p.id) })),
    ...fromLabel.map(({ period, byCurrency }) => ({ key: `label-${period.id}`, href: `/from-label/${m!.linkId}/statement/${period.id}`, period, byCurrency })),
  ].sort((a, b) => b.period.endDate.localeCompare(a.period.endDate) || b.period.startDate.localeCompare(a.period.startDate) || b.period.id - a.period.id);
  // Which band a payout was for: only worth a column for a label with more than one.
  const showFor = ctx.org.kind === "label" && bands.length > 1;

  const newPayout = (
    <>
      {/* A band account has one band: nothing to choose. */}
      {ctx.org.kind === "label" && <BandFilter path="/periods" bands={bands} current={forBand?.id} all="whole label" look="tabs" label="pay:" />}
      <ActionForm action={previewPayout} className="grid gap-4 sm:grid-cols-4">
        {forBand && <input type="hidden" name="bandId" value={forBand.id} />}
        <Field label="Name (optional)">
          <input name="name" placeholder={forBand ? `${forBand.name} — ${periodName(defaultStart, defaultEnd)}` : periodName(defaultStart, defaultEnd)} />
        </Field>
        <Field label="From">
          <input name="startDate" type="date" required defaultValue={defaultStart} />
        </Field>
        <Field label="To">
          <input name="endDate" type="date" required defaultValue={defaultEnd} />
        </Field>
        <div className="self-end">
          <SubmitButton>Preview</SubmitButton>
        </div>
      </ActionForm>
    </>
  );

  return (
    <>
      <PageHeader title="Payouts" />
      {!salesRange?.first && !m && (
        <Callout tone="neutral">
          No sales imported yet. <Link href="/sales/import">Import a Bandcamp sales report</Link> first, then create a payout for it.
        </Callout>
      )}
      {owesOwn ? (
        <>
          <ChartBoard boardId="payouts" charts={[owed]} saved={owedLayout} />
          <Card title="New payout">{newPayout}</Card>
        </>
      ) : (
        <Card>
          {owesFromLabel.size ? (
            <p>
              {m!.labelName} still owes {ctx.org.name} <MoneyList totals={owesFromLabel} />.
            </p>
          ) : (
            <p>All funds are paid out.</p>
          )}
          {/* (A band account the label made pays from its own books only what came before the label.) */}
          {salesRange?.first && (
            <div className="mt-4">
              <Disclosure summary="+ New payout">{newPayout}</Disclosure>
            </div>
          )}
        </Card>
      )}

      <Card title="Finalized payouts">
        {rows.length === 0 ? (
          <Empty>No finalized payouts yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>Payout</th>
                  {showFor && <th>For</th>}
                  <th className="hidden sm:table-cell">Dates</th>
                  <th>Status</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ key, href, period: p, byCurrency }) => (
                  <tr key={key}>
                    <td>
                      <Link href={href} className="font-medium hover:underline">
                        {p.name}
                      </Link>
                    </td>
                    {showFor && <td className="text-sm">{p.bandId ? bandName.get(p.bandId) : <span className="text-muted">whole label</span>}</td>}
                    <td className="hidden whitespace-nowrap text-muted sm:table-cell">
                      {p.startDate} → {p.endDate}
                    </td>
                    <td>
                      <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
                    </td>
                    <td className="num">
                      {[...byCurrency].map(([c, v]) => (
                        <div key={c}>
                          <Money cents={v.total} currency={c} />
                          {v.paid < v.total && (
                            <div className="text-xs text-muted">
                              <Money cents={v.total - v.paid} currency={c} /> to pay
                            </div>
                          )}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
