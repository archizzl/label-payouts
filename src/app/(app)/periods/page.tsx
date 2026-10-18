import { and, asc, desc, eq, isNotNull, max, min, notExists, sql } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { ActionForm, SubmitButton } from "@/components/client";
import { ChartBoard } from "@/components/chart-board";
import { owedChart } from "@/components/owed";
import { loadLayout } from "@/server/chart-layouts";
import { Badge, Callout, Card, Empty, Field, Money, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { periodName } from "@/lib/dates";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/status";
import { previewPayout } from "@/server/actions";
import { bandcampCredentials } from "@/server/bandcamp-api";
import { requireAccess } from "@/server/context";
import { labelPayoutsFor, syncOwnPeople } from "@/server/own-books";

export const metadata = { title: "payouts" };

export default async function PeriodsPage({ searchParams }: PageProps<"/periods">) {
  await connection();
  const ctx = await requireAccess("payouts");
  const { orgId } = ctx;
  // A band account the label made: its own payouts, and the label's that paid its members.
  const m = ctx.managedBy;
  if (m) await syncOwnPeople(orgId);
  const [periods, payouts, bands, [salesRange], creds, fromLabel] = await Promise.all([
    db.select().from(schema.periods).where(eq(schema.periods.orgId, orgId)).orderBy(desc(schema.periods.startDate)),
    db.select().from(schema.payouts).where(eq(schema.payouts.orgId, orgId)),
    db.select().from(schema.bands).where(eq(schema.bands.orgId, orgId)).orderBy(asc(schema.bands.name)),
    db
      .select({ first: min(schema.sales.date), last: max(schema.sales.date) })
      .from(schema.sales)
      .where(eq(schema.sales.orgId, orgId)),
    bandcampCredentials(orgId),
    m ? labelPayoutsFor(m.labelOrgId, m.bandId) : [],
  ]);
  const [owed, owedLayout] = await Promise.all([owedChart(orgId), loadLayout("payouts")]);
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
    ...periods.map((p) => ({ key: `own-${p.id}`, href: `/periods/${p.id}`, period: p, byCurrency: totalsOf(p.id), through: null as string | null })),
    ...fromLabel.map(({ period, byCurrency }) => ({
      key: `label-${period.id}`,
      href: `/from-label/${m!.linkId}/statement/${period.id}`,
      period,
      byCurrency,
      through: m!.labelName,
    })),
  ].sort((a, b) => b.period.startDate.localeCompare(a.period.startDate));

  return (
    <>
      <PageHeader title="Payouts" />
      {!salesRange?.first && (
        <Callout tone="neutral">
          No sales imported yet. <Link href="/sales/import">Import a Bandcamp sales report</Link> first, then create a payout for it.
        </Callout>
      )}
      <ChartBoard boardId="payouts" charts={[owed]} saved={owedLayout} />

      <Card title="New payout">
        {/* A band account has one band: nothing to choose. */}
        {ctx.org.kind === "label" && (
          <nav className="mb-4 flex flex-wrap gap-x-5 gap-y-2 text-sm" aria-label="Who to pay">
            <span className="text-muted">pay:</span>
            {[{ id: null as number | null, name: "whole label" }, ...bands.map((b) => ({ id: b.id as number | null, name: b.name }))].map((o) => {
              const on = (forBand?.id ?? null) === o.id;
              return (
                <Link
                  key={o.id ?? "all"}
                  href={o.id ? `/periods?band=${o.id}` : "/periods"}
                  scroll={false}
                  className={`border-b-2 pb-0.5 hover:no-underline ${on ? "border-accent font-bold text-text" : "border-transparent text-muted hover:text-text"}`}
                >
                  {o.name}
                </Link>
              );
            })}
          </nav>
        )}
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
        {/* <p className="mt-2 text-xs text-muted">
          {forBand
            ? `Pays only ${forBand.name}’s sales. `
            : "Pays every band’s sales. "}
          {reachesBack
            ? `Starts at the earliest sale nobody’s been paid for yet (${firstUnpaid}), from before the last payout. `
            : lastClosed
              ? `Starts on the day the last payout covering ${forBand ? "them" : "the whole label"} ended (${lastClosed}), to catch sales made later that day. `
              : ""}
          Sales already paid by another finalized payout are left out automatically, so nothing is paid twice.
          {creds && " New sales are pulled from Bandcamp first."} Nothing is saved until you finalize.
        </p> */}
      </Card>


      <Card title="Finalized payouts">
        {rows.length === 0 ? (
          <Empty>No finalized payouts yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>Payout</th>
                  <th>For</th>
                  <th>Dates</th>
                  <th>Status</th>
                  <th className="num">To people</th>
                  <th className="num">Paid or kept</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ key, href, period: p, byCurrency, through }) => (
                  <tr key={key}>
                    <td>
                      <Link href={href} className="font-medium hover:underline">
                        {p.name}
                      </Link>
                    </td>
                    <td className="text-sm">
                      {through ? (
                        <span className="text-muted">through {through}</span>
                      ) : p.bandId ? (
                        bandName.get(p.bandId)
                      ) : ctx.org.kind === "band" ? (
                        ctx.org.name
                      ) : (
                        <span className="text-muted">whole label</span>
                      )}
                    </td>
                    <td className="text-muted">
                      {p.startDate} → {p.endDate}
                    </td>
                    <td>
                      <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
                    </td>
                    <td className="num">
                      {[...byCurrency].map(([c, v]) => (
                        <div key={c}>
                          <Money cents={v.total} currency={c} />
                        </div>
                      ))}
                    </td>
                    <td className="num">
                      {[...byCurrency].map(([c, v]) => (
                        <div key={c}>
                          <Money cents={v.paid} currency={c} />
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
