import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import Link from "next/link";
import { Badge, Card, Empty, Money, MoneyList } from "@/components/ui";
import { db, schema } from "@/db";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/status";
import { nameMaps } from "@/server/data";

const PAYOUT_STATUS = { pending: "to be paid", paid: "paid", kept: "kept by the label account holder" } as const;

/** One band's part of the label's payouts: each payout that paid its members, and what each got. Read-only. */
export async function BandPayouts({
  labelOrgId,
  bandId,
  bandName,
  statementHref,
}: {
  labelOrgId: string;
  bandId: number;
  bandName: string;
  statementHref: (periodId: number) => string;
}) {
  const [periods, names] = await Promise.all([
    db
      .select()
      .from(schema.periods)
      .where(and(eq(schema.periods.orgId, labelOrgId), or(eq(schema.periods.bandId, bandId), isNull(schema.periods.bandId))))
      .orderBy(desc(schema.periods.endDate)),
    nameMaps(labelOrgId),
  ]);
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

  return (
    <>
      <Card title="Payouts">
        {paidPeriods.length === 0 ? (
          <Empty>No payouts for {bandName} yet.</Empty>
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
                      <Link href={statementHref(p.id)}>statement</Link>
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
    </>
  );
}

/**
 * What each of the band's members has been paid from the label, in total (their share of this band
 * only): paid out (or kept in the label's account), and waiting to be paid.
 */
export async function BandPayoutTotals({ labelOrgId, bandId, allHref }: { labelOrgId: string; bandId: number; allHref?: string }) {
  const [rows, names] = await Promise.all([
    db.select().from(schema.payouts).where(eq(schema.payouts.orgId, labelOrgId)),
    nameMaps(labelOrgId),
  ]);
  const totals = new Map<number, { paid: Map<string, number>; waiting: Map<string, number> }>();
  for (const p of rows) {
    const cents = p.byBand[String(bandId)] ?? 0;
    if (!cents) continue;
    const t = totals.get(p.personId) ?? { paid: new Map(), waiting: new Map() };
    const m = p.status === "pending" ? t.waiting : t.paid;
    m.set(p.currency, (m.get(p.currency) ?? 0) + cents);
    totals.set(p.personId, t);
  }
  const people = [...totals].sort((a, b) => (names.person.get(a[0]) ?? "").localeCompare(names.person.get(b[0]) ?? ""));
  return (
    <Card title="Payouts" actions={allHref && people.length > 0 ? <Link href={allHref} className="text-sm">all payouts</Link> : undefined}>
      {people.length === 0 ? (
        <Empty>No payouts yet.</Empty>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Member</th>
              <th className="num">Paid</th>
              <th className="num">Waiting to be paid</th>
            </tr>
          </thead>
          <tbody>
            {people.map(([personId, t]) => (
              <tr key={personId}>
                <td>{names.person.get(personId)}</td>
                <td className="num">{t.paid.size ? <MoneyList totals={t.paid} /> : "—"}</td>
                <td className="num">{t.waiting.size ? <MoneyList totals={t.waiting} /> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
