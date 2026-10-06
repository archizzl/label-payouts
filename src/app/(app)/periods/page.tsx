import { asc, desc, eq, max, min } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { ActionForm, SubmitButton } from "@/components/client";
import { LabelFunds } from "@/components/label-funds";
import { Owed } from "@/components/owed";
import { Badge, Callout, Card, Empty, Field, Money, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { addDays, periodName, previousMonth } from "@/lib/dates";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/status";
import { previewPayout } from "@/server/actions";
import { bandcampCredentials } from "@/server/bandcamp-api";
import { requireAdmin } from "@/server/context";

export default async function PeriodsPage({ searchParams }: PageProps<"/periods">) {
  await connection();
  const { orgId } = await requireAdmin();
  const [periods, payouts, bands, [salesRange], creds] = await Promise.all([
    db.select().from(schema.periods).where(eq(schema.periods.orgId, orgId)).orderBy(desc(schema.periods.startDate)),
    db.select().from(schema.payouts).where(eq(schema.payouts.orgId, orgId)),
    db.select().from(schema.bands).where(eq(schema.bands.orgId, orgId)).orderBy(asc(schema.bands.name)),
    db
      .select({ first: min(schema.sales.date), last: max(schema.sales.date) })
      .from(schema.sales)
      .where(eq(schema.sales.orgId, orgId)),
    bandcampCredentials(orgId),
  ]);
  const bandName = new Map(bands.map((b) => [b.id, b.name]));
  // Who this payout is for: the whole label, or one band (?band=ID).
  const bandParam = Number((await searchParams).band);
  const forBand = bands.find((b) => b.id === bandParam) ?? null;
  // The last finalized payout that covers this choice: for a band, its own or a label-wide one.
  const lastClosed = periods
    .filter((p) => (forBand ? p.bandId === null || p.bandId === forBand.id : p.bandId === null))
    .reduce<string | undefined>((a, p) => (!a || p.endDate > a ? p.endDate : a), undefined);
  // Default to the next unpaid stretch: from the day after the last finalized period (or the first
  // sale), up to the end of last month. With no sales yet, just last month.
  const today = new Date().toISOString().slice(0, 10);
  const [lastMonthStart, lastMonthEnd] = previousMonth(today);
  const defaultStart = lastClosed ? addDays(lastClosed, 1) : (salesRange?.first ?? lastMonthStart);
  const defaultEnd = lastMonthEnd >= defaultStart ? lastMonthEnd : (salesRange?.last && salesRange.last >= defaultStart ? salesRange.last : today);

  return (
    <>
      <PageHeader title="Payouts" subtitle="A payout covers a date range of sales. Preview it, finalize it, then pay everyone." />
      {!salesRange?.first && (
        <Callout tone="neutral">
          No sales imported yet. <Link href="/import">Import a Bandcamp sales report</Link> first, then create a payout for it.
        </Callout>
      )}
      <Owed orgId={orgId} />

      <Card title="New payout">
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
        <ActionForm action={previewPayout} className="grid gap-4 sm:grid-cols-4">
          {forBand && <input type="hidden" name="bandId" value={forBand.id} />}
          <Field label="Name (optional)" hint="Left blank, it’s named after the band and dates.">
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
        <p className="mt-2 text-xs text-muted">
          {forBand
            ? `Pays only ${forBand.name}’s sales. `
            : "Pays every band’s sales. "}
          {lastClosed ? `Starts the day after the last payout covering ${forBand ? "them" : "the whole label"} (${lastClosed}). ` : ""}
          Sales already paid by another finalized payout are left out automatically, so nothing is paid twice.
          {creds && " New sales are pulled from Bandcamp first."} Nothing is saved until you finalize.
        </p>
      </Card>

      <LabelFunds />

      <Card title="Finalized payouts">
        {periods.length === 0 ? (
          <Empty>No finalized payouts yet.</Empty>
        ) : (
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
              {periods.map((p) => {
                const mine = payouts.filter((x) => x.periodId === p.id);
                const byCur = new Map<string, { total: number; paid: number }>();
                for (const x of mine) {
                  const e = byCur.get(x.currency) ?? { total: 0, paid: 0 };
                  e.total += x.amountCents;
                  if (x.status !== "pending") e.paid += x.amountCents;
                  byCur.set(x.currency, e);
                }
                return (
                  <tr key={p.id}>
                    <td>
                      <Link href={`/periods/${p.id}`} className="font-medium hover:underline">
                        {p.name}
                      </Link>
                    </td>
                    <td className="text-sm">{p.bandId ? bandName.get(p.bandId) : <span className="text-muted">whole label</span>}</td>
                    <td className="text-muted">
                      {p.startDate} → {p.endDate}
                    </td>
                    <td>
                      <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
                    </td>
                    <td className="num">
                      {[...byCur].map(([c, v]) => (
                        <div key={c}>
                          <Money cents={v.total} currency={c} />
                        </div>
                      ))}
                    </td>
                    <td className="num">
                      {[...byCur].map(([c, v]) => (
                        <div key={c}>
                          <Money cents={v.paid} currency={c} />
                        </div>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
