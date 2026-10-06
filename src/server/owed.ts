import "server-only";
import { and, eq, max, min } from "drizzle-orm";
import { db, schema } from "@/db";
import { labelFunds } from "./data";
import { previewView } from "./period-view";

/*
 * What the label still owes, band by band (and to outside groups it raised money for):
 *  - finalized: in a finalized payout, not marked paid yet;
 *  - unpaid: sales no finalized payout covers yet (what the next payout would pay out);
 *  - receipts: approved receipts people paid for themselves, that the label pays back directly;
 *  - raised: money kept for a cause (e.g. a fundraiser) and not sent on yet.
 * People whose money stays in the label's bank account are left out: nothing has to be sent to them.
 */

export type OwedPerson = { name: string; cents: number };
export type OwedRow = {
  key: string;
  name: string;
  /** A band (pay it from /periods?band=ID), the label's own releases, or an outside group. */
  kind: "band" | "label" | "group";
  bandId: number | null;
  currency: string;
  finalized: number;
  unpaid: number;
  receipts: number;
  raised: number;
  /** Who in the band it's owed to, biggest first (for the tooltip). */
  people: OwedPerson[];
};

const total = (r: OwedRow) => r.finalized + r.unpaid + r.receipts + r.raised;
export const owedTotal = total;

export async function owedByBand(orgId: string): Promise<OwedRow[]> {
  const [bands, people, pending, [range], receipts, funds] = await Promise.all([
    db.select().from(schema.bands).where(eq(schema.bands.orgId, orgId)),
    db.select().from(schema.people).where(eq(schema.people.orgId, orgId)),
    db
      .select()
      .from(schema.payouts)
      .where(and(eq(schema.payouts.orgId, orgId), eq(schema.payouts.status, "pending"))),
    db
      .select({ first: min(schema.sales.date), last: max(schema.sales.date) })
      .from(schema.sales)
      .where(eq(schema.sales.orgId, orgId)),
    db
      .select()
      .from(schema.expenses)
      .where(and(eq(schema.expenses.orgId, orgId), eq(schema.expenses.status, "approved"), eq(schema.expenses.paidBy, "person"))),
    labelFunds(orgId),
  ]);
  const bandName = new Map(bands.map((b) => [b.id, b.name]));
  const person = new Map(people.map((p) => [p.id, p]));

  const rows = new Map<string, OwedRow & { byPerson: Map<string, number> }>();
  const rowFor = (bandId: number | null, currency: string) => {
    const k = `${bandId ?? "label"}|${currency}`;
    let r = rows.get(k);
    if (!r) {
      r = {
        key: k,
        name: bandId ? (bandName.get(bandId) ?? `Band #${bandId}`) : "Label releases",
        kind: bandId ? "band" : "label",
        bandId,
        currency,
        finalized: 0,
        unpaid: 0,
        receipts: 0,
        raised: 0,
        people: [],
        byPerson: new Map(),
      };
      rows.set(k, r);
    }
    return r;
  };
  const toPerson = (r: { byPerson: Map<string, number> }, personId: number | null, cents: number) => {
    const name = (personId && person.get(personId)?.name) || "Unknown";
    r.byPerson.set(name, (r.byPerson.get(name) ?? 0) + cents);
  };
  const sendsTo = (personId: number) => !person.get(personId)?.holdsLabelAccount;

  // Finalized payouts not paid yet.
  for (const p of pending) {
    if (!sendsTo(p.personId)) continue;
    for (const [b, cents] of Object.entries(p.byBand)) {
      const r = rowFor(Number(b) || null, p.currency);
      r.finalized += cents;
      toPerson(r, p.personId, cents);
    }
  }

  // Sales no finalized payout covers yet: what a whole-label payout would pay out today.
  if (range?.first && range.last) {
    const view = await previewView(orgId, { bandId: null, startDate: range.first, endDate: range.last });
    for (const line of view.lines) {
      if (line.holdsLabelAccount) continue;
      for (const { bandId, cents } of line.byBand) {
        const r = rowFor(bandId || null, line.currency);
        r.unpaid += cents;
        toPerson(r, line.personId, cents);
      }
    }
  }

  // Receipts the label pays back itself (ones paid back from sales are already in the payouts).
  for (const e of receipts) {
    if (e.recoup || e.reimbursedAt) continue;
    const r = rowFor(e.bandId, e.currency);
    r.receipts += e.amountCents;
    toPerson(r, e.paidByPersonId, e.amountCents);
  }

  // Money raised for a cause and not all sent on yet, to whoever it was last sent to.
  for (const c of funds.causes) {
    const recipient = funds.transfers.find((t) => (t.releaseId ?? null) === c.releaseId && (t.bandId ?? null) === c.bandId)?.recipient;
    for (const [currency, raised] of c.raised) {
      const left = raised - (c.sent.get(currency) ?? 0);
      if (left <= 0 || !recipient) continue;
      const from = c.bandId ? bandName.get(c.bandId) : null;
      rows.set(`group|${recipient}|${c.bandId}|${c.releaseId}|${currency}`, {
        key: `group|${recipient}|${c.bandId}|${c.releaseId}|${currency}`,
        name: from ? `${recipient} (via ${from})` : recipient,
        kind: "group",
        bandId: c.bandId,
        currency,
        finalized: 0,
        unpaid: 0,
        receipts: 0,
        raised: left,
        people: [],
        byPerson: new Map(),
      });
    }
  }

  return [...rows.values()]
    .map(({ byPerson, ...r }) => ({
      ...r,
      people: [...byPerson].map(([name, cents]) => ({ name, cents })).filter((p) => p.cents > 0).sort((a, b) => b.cents - a.cents),
    }))
    .filter((r) => total(r) > 0)
    .sort((a, b) => a.currency.localeCompare(b.currency) || total(b) - total(a));
}
