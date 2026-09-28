import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { PayoutLine } from "@/lib/paypal-export";
import { periodName } from "@/lib/dates";
import { computePayoutPeriod, nameMaps } from "./data";

/** What a payout covers: one band (or the whole label) over a date range. */
export type PayoutScope = { bandId: number | null; startDate: string; endDate: string };

type Period = typeof schema.periods.$inferSelect;

export type PersonLine = {
  personId: number;
  name: string;
  email: string | null;
  paypalMe: string | null;
  venmo: string | null;
  cashtag: string | null;
  /** Holds the label's bank account: their money stays there instead of being sent. */
  holdsLabelAccount: boolean;
  currency: string;
  amountCents: number;
  byBand: { bandId: number; cents: number }[];
  payoutId: number | null;
  status: "pending" | "paid" | "kept" | null;
  paidAt: string | null;
  reference: string | null;
};

export type BandLine = {
  bandId: number | null;
  currency: string;
  saleCount: number;
  netCents: number;
  labelCents: number;
  bandFundCents: number;
  expenseCents: number;
  peopleCents: number;
  unallocatedCents: number;
};

/** The default name of a payout, e.g. "Flag Day — August 2026". */
export function payoutName(scope: PayoutScope) {
  const band = scope.bandId ? db.select().from(schema.bands).where(eq(schema.bands.id, scope.bandId)).get() : undefined;
  return band ? `${band.name} — ${periodName(scope.startDate, scope.endDate)}` : periodName(scope.startDate, scope.endDate);
}

/** A finalized payout: its locked amounts and payment status, plus today's calculation for comparison. */
export function periodView(periodId: number) {
  const period = db.select().from(schema.periods).where(eq(schema.periods.id, periodId)).get();
  if (!period) return null;
  return { ...buildView(period, period), period };
}

/** A payout that hasn't been finalized: computed on the fly, nothing stored. */
export function previewView(scope: PayoutScope) {
  return buildView(scope, null);
}

function buildView(scope: PayoutScope, period: Period | null) {
  const live = computePayoutPeriod({ id: period?.id ?? 0, ...scope });
  const names = nameMaps();
  const peopleRows = new Map(db.select().from(schema.people).all().map((p) => [p.id, p]));
  const person = (id: number) => peopleRows.get(id);

  const liveLines: PersonLine[] = [];
  for (const cur of live.summary.currencies) {
    for (const [personId, p] of live.summary.byCurrency[cur].byPerson) {
      liveLines.push({
        personId,
        name: person(personId)?.name ?? `#${personId}`,
        email: person(personId)?.email ?? null,
        paypalMe: person(personId)?.paypalMe ?? null,
        venmo: person(personId)?.venmo ?? null,
        cashtag: person(personId)?.cashtag ?? null,
        holdsLabelAccount: person(personId)?.holdsLabelAccount ?? false,
        currency: cur,
        amountCents: p.total,
        byBand: [...p.byBand].map(([bandId, cents]) => ({ bandId, cents })),
        payoutId: null,
        status: null,
        paidAt: null,
        reference: null,
      });
    }
  }

  const finalized = period !== null;
  const payoutRows = period ? db.select().from(schema.payouts).where(eq(schema.payouts.periodId, period.id)).all() : [];
  const lines: PersonLine[] = finalized
    ? payoutRows.map((r) => ({
        personId: r.personId,
        name: person(r.personId)?.name ?? `#${r.personId}`,
        email: person(r.personId)?.email ?? null,
        paypalMe: person(r.personId)?.paypalMe ?? null,
        venmo: person(r.personId)?.venmo ?? null,
        cashtag: person(r.personId)?.cashtag ?? null,
        holdsLabelAccount: person(r.personId)?.holdsLabelAccount ?? false,
        currency: r.currency,
        amountCents: r.amountCents,
        byBand: Object.entries(r.byBand).map(([b, cents]) => ({ bandId: Number(b), cents })),
        payoutId: r.id,
        status: r.status,
        paidAt: r.paidAt,
        reference: r.reference,
      }))
    : liveLines.filter((l) => l.amountCents !== 0);
  lines.sort((a, b) => a.name.localeCompare(b.name) || a.currency.localeCompare(b.currency));

  // Did rules or sales change after finalizing?
  const key = (l: PersonLine) => `${l.personId}|${l.currency}|${l.amountCents}`;
  const drift =
    finalized &&
    [...new Set(liveLines.filter((l) => l.amountCents !== 0).map(key))].sort().join() !== [...new Set(lines.map(key))].sort().join();

  const bandLines = new Map<string, BandLine>();
  for (const r of live.results) {
    const k = `${r.bandId}|${r.currency}`;
    const b = bandLines.get(k) ?? {
      bandId: r.bandId,
      currency: r.currency,
      saleCount: 0,
      netCents: 0,
      labelCents: 0,
      bandFundCents: 0,
      expenseCents: 0,
      peopleCents: 0,
      unallocatedCents: 0,
    };
    b.saleCount++;
    b.netCents += r.netCents;
    for (const d of r.deductions) {
      if (d.destination === "person") continue; // included in peopleCents via shares
      if (d.destination === "label") b.labelCents += d.cents;
      else if (d.destination === "band_fund") b.bandFundCents += d.cents;
      else b.expenseCents += d.cents;
    }
    b.peopleCents += r.shares.reduce((a, s) => a + s.cents, 0);
    b.unallocatedCents += r.unallocatedCents;
    bandLines.set(k, b);
  }
  const bands = [...bandLines.values()].sort(
    (a, b) => (a.bandId === null ? 1 : 0) - (b.bandId === null ? 1 : 0) || (names.band.get(a.bandId!) ?? "").localeCompare(names.band.get(b.bandId!) ?? ""),
  );

  const problems = {
    unrouted: live.results.filter((r) => r.problem === "unrouted").length,
    noRule: live.results.filter((r) => r.problem === "no_rule").length,
    noRuleBands: [...new Set(live.results.filter((r) => r.problem === "no_rule").map((r) => r.bandId!))],
  };

  const deductionPerson = new Map(
    db
      .select()
      .from(schema.deductions)
      .all()
      .filter((d) => d.personId)
      .map((d) => [d.id, d.personId!]),
  );

  return { period, scope, live, lines, bands, names, problems, drift, finalized, deductionPerson };
}

export function payoutNote(periodName: string, line: PersonLine, bandName: (id: number) => string) {
  // Band payouts are already named after the band; don't repeat it.
  const bands = line.byBand
    .map((b) => bandName(b.bandId))
    .filter((n) => !periodName.includes(n))
    .join(", ");
  return `Label payout ${periodName}${bands ? `: ${bands}` : ""}`;
}

export function toPayoutLines(view: NonNullable<ReturnType<typeof periodView>>): PayoutLine[] {
  const bandName = (id: number) => view.names.band.get(id) ?? "Unknown band";
  return view.lines
    .filter((l) => l.status === "pending")
    .map((l) => ({
      personName: l.name,
      email: l.email,
      paypalMe: l.paypalMe,
      currency: l.currency,
      amountCents: l.amountCents,
      note: payoutNote(view.period.name, l, bandName),
      referenceId: `P${view.period.id}-${l.personId}-${l.currency}`,
    }));
}
