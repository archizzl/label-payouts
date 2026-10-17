import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { computePayoutPeriod } from "./data";

/*
 * Someone's earnings in one set of books: their payouts, what's waiting to be paid, what they've
 * received, and what they've earned since the last payout. For a band account the label made, it's
 * worked out in the label's books (just its band's part) and in its own, and added together.
 */

export type Totals = Map<string, number>;

/** Their earnings in these books; with `bandId`, only that band's part of each payout. */
export async function earningsIn(orgId: string, personId: number, bandId: number | null = null) {
  const [rows, unpaid] = await Promise.all([
    db
      .select({ payout: schema.payouts, period: schema.periods })
      .from(schema.payouts)
      .innerJoin(schema.periods, eq(schema.periods.id, schema.payouts.periodId))
      .where(and(eq(schema.payouts.orgId, orgId), eq(schema.payouts.personId, personId)))
      .orderBy(desc(schema.periods.endDate)),
    // Sales no finalized payout has covered yet: what they've earned since the last one.
    computePayoutPeriod(orgId, { id: 0, bandId, startDate: "0000-01-01", endDate: "9999-12-31" }),
  ]);
  const lines = rows
    .map(({ payout, period }) => ({ payout, period, cents: bandId === null ? payout.amountCents : (payout.byBand[String(bandId)] ?? 0) }))
    .filter((l) => l.cents !== 0);
  const owed: Totals = new Map();
  const received: Totals = new Map();
  for (const l of lines) add(l.payout.status === "pending" ? owed : received, l.payout.currency, l.cents);
  const upcoming = unpaid.summary.currencies
    .map((cur) => ({ cur, line: unpaid.summary.byCurrency[cur].byPerson.get(personId) }))
    .filter((x): x is { cur: string; line: NonNullable<typeof x.line> } => !!x.line && x.line.total !== 0);
  return { lines, owed, received, upcoming };
}

function add(m: Totals, currency: string, cents: number) {
  m.set(currency, (m.get(currency) ?? 0) + cents);
}

/** Two sets of totals added up, per currency. */
export function addTotals(a: Totals, b: Totals): Totals {
  const out = new Map(a);
  for (const [cur, cents] of b) add(out, cur, cents);
  return out;
}
