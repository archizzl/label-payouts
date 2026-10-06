import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { parseCents } from "@/lib/money";
import { computeAllTime, labelFunds } from "./data";

/*
 * Where the label's money comes from, piece by piece: each withholding that goes to the label (its
 * cut, CD costs, a fundraiser…), its own share of label releases, and the shipping fans paid (never
 * split: it stays with the label for postage). Also the label account holder's own share, which sits
 * in the same account but is theirs, not the label's.
 */

export type Totals = Map<string, number>;
const add = (m: Totals, cur: string, cents: number) => m.set(cur, (m.get(cur) ?? 0) + cents);

export const SHIPPING_SOURCE = "Shipping (for postage)";
export const LABEL_RELEASES_SOURCE = "Label releases (its own share)";

export async function labelIncome(orgId: string) {
  const [{ results, saleById }, funds, holders, bandRows] = await Promise.all([
    computeAllTime(orgId),
    labelFunds(orgId),
    db
      .select({ id: schema.people.id, name: schema.people.name })
      .from(schema.people)
      .where(and(eq(schema.people.orgId, orgId), eq(schema.people.holdsLabelAccount, true))),
    db.select({ id: schema.bands.id, name: schema.bands.name }).from(schema.bands).where(eq(schema.bands.orgId, orgId)),
  ]);
  const holderIds = new Set(holders.map((h) => h.id));
  const bandName = new Map(bandRows.map((b) => [b.id, b.name]));

  const bySource = new Map<string, Totals>();
  const byBand = new Map<string, Totals>();
  const byMonth = new Map<string, Totals>(); // "2026-05" → label money that month
  const income: Totals = new Map();
  const holderShare: Totals = new Map();

  const credit = (source: string, cur: string, cents: number, bandId: number | null, date: string) => {
    if (!cents) return;
    const s = bySource.get(source) ?? new Map();
    add(s, cur, cents);
    bySource.set(source, s);
    const bandKey = bandId ? (bandName.get(bandId) ?? `Band #${bandId}`) : "Not matched to a band";
    const b = byBand.get(bandKey) ?? new Map();
    add(b, cur, cents);
    byBand.set(bandKey, b);
    const m = byMonth.get(date.slice(0, 7)) ?? new Map();
    add(m, cur, cents);
    byMonth.set(date.slice(0, 7), m);
    add(income, cur, cents);
  };

  for (const r of results) {
    const sale = saleById.get(r.saleId)!;
    for (const d of r.deductions) {
      if (d.destination !== "label") continue;
      credit(d.deductionId === 0 ? LABEL_RELEASES_SOURCE : d.label, r.currency, d.cents, r.bandId, sale.date);
    }
    const raw = sale.raw.shipping;
    if (raw) credit(SHIPPING_SOURCE, r.currency, Math.abs(parseCents(raw)) * (Math.sign(r.netCents) || 1), r.bandId, sale.date);
    for (const s of r.shares) if (holderIds.has(s.personId)) add(holderShare, r.currency, s.cents);
  }

  const balance: Totals = new Map();
  for (const cur of new Set([...income.keys(), ...funds.sent.keys(), ...funds.spent.keys()])) {
    balance.set(cur, (income.get(cur) ?? 0) - (funds.sent.get(cur) ?? 0) - (funds.spent.get(cur) ?? 0));
  }
  const currencies = [...new Set([...income.keys(), ...balance.keys()])].sort((a, b) => Math.abs(income.get(b) ?? 0) - Math.abs(income.get(a) ?? 0));

  return {
    currencies,
    income,
    sent: funds.sent,
    spent: funds.spent,
    balance,
    holderShare,
    holderName: holders.length === 1 ? holders[0].name : null,
    bySource,
    byBand,
    byMonth,
  };
}
