import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { computeAllTime } from "./data";
import { expenseDeductionId } from "./expenses";

/*
 * Projects: what was spent on an album (or EP, tour, video…) against what its releases have made
 * back on Bandcamp. "Made back" is the net Bandcamp paid out for those sales (after its own share
 * and payment fees), before the label's cut and the split, so it's directly comparable with what
 * was spent.
 */

export type Project = typeof schema.projects.$inferSelect;

export type ProjectNumbers = {
  currency: string;
  /** Approved expenses. */
  spent: number;
  /** Submitted but not approved yet (not counted in spent). */
  pending: number;
  /** Net from Bandcamp for the project's releases. */
  madeBack: number;
  units: number;
  /** Where the money made back went. */
  labelKept: number;
  bandFunds: number;
  toPeople: number;
  /** Of the money made back, how much paid back this project's own expenses. */
  recouped: number;
  balance: number;
  byCategory: { category: string; cents: number }[];
  byRelease: { releaseId: number; title: string; kind: string; artUrl: string | null; net: number; units: number }[];
  /** Running totals by month, for the chart. */
  monthly: { month: string; spent: number; madeBack: number }[];
  firstSale: string | null;
  /** Sales or expenses in other currencies, not converted (listed separately). */
  otherCurrencies: string[];
};

const monthOf = (date: string) => date.slice(0, 7);

function monthsBetween(from: string, to: string) {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export async function accountProjects(orgId: string) {
  return db.select().from(schema.projects).where(eq(schema.projects.orgId, orgId)).orderBy(schema.projects.name);
}

/** The numbers for every project in the account (or one), in each project's own currency. */
export async function projectNumbers(orgId: string, onlyId?: number): Promise<Map<number, ProjectNumbers>> {
  const [projectRows, links, expenseRows, releaseRows, { results, saleById }] = await Promise.all([
    db
      .select()
      .from(schema.projects)
      .where(and(eq(schema.projects.orgId, orgId), onlyId !== undefined ? eq(schema.projects.id, onlyId) : undefined)),
    db.select().from(schema.projectReleases).where(eq(schema.projectReleases.orgId, orgId)),
    db.select().from(schema.expenses).where(eq(schema.expenses.orgId, orgId)),
    db
      .select({ id: schema.releases.id, title: schema.releases.title, kind: schema.releases.kind, artUrl: schema.releases.artUrl })
      .from(schema.releases)
      .where(eq(schema.releases.orgId, orgId)),
    computeAllTime(orgId),
  ]);
  const releaseInfo = new Map(releaseRows.map((r) => [r.id, r]));
  const thisMonth = new Date().toISOString().slice(0, 7);
  const out = new Map<number, ProjectNumbers>();

  for (const p of projectRows) {
    const cur = p.currency;
    const releaseIds = new Set(links.filter((l) => l.projectId === p.id).map((l) => l.releaseId));
    const mine = expenseRows.filter((e) => e.projectId === p.id && e.status !== "rejected");
    const approved = mine.filter((e) => e.status === "approved" && e.currency === cur);
    const ownCosts = new Set(mine.map((e) => expenseDeductionId(e.id)));
    const sales = results.filter((r) => {
      const s = saleById.get(r.saleId);
      return s?.releaseId != null && releaseIds.has(s.releaseId);
    });
    const inCur = sales.filter((r) => r.currency === cur);

    const n: ProjectNumbers = {
      currency: cur,
      spent: approved.reduce((a, e) => a + e.amountCents, 0),
      pending: mine.filter((e) => e.status === "pending" && e.currency === cur).reduce((a, e) => a + e.amountCents, 0),
      madeBack: 0,
      units: 0,
      labelKept: 0,
      bandFunds: 0,
      toPeople: 0,
      recouped: 0,
      balance: 0,
      byCategory: [],
      byRelease: [],
      monthly: [],
      firstSale: null,
      otherCurrencies: [...new Set([...sales.map((r) => r.currency), ...mine.map((e) => e.currency)].filter((c) => c !== cur))],
    };
    const perRelease = new Map<number, { net: number; units: number }>();
    const spentByMonth = new Map<string, number>();
    const madeByMonth = new Map<string, number>();
    for (const r of inCur) {
      const s = saleById.get(r.saleId)!;
      const units = Math.max(1, s.quantity) * Math.sign(r.netCents || 1);
      n.madeBack += r.netCents;
      n.units += units;
      n.toPeople += r.shares.reduce((a, x) => a + x.cents, 0);
      for (const d of r.deductions) {
        if (ownCosts.has(d.deductionId)) n.recouped += d.cents;
        if (d.destination === "label") n.labelKept += d.cents;
        else if (d.destination === "band_fund") n.bandFunds += d.cents;
      }
      const pr = perRelease.get(s.releaseId!) ?? { net: 0, units: 0 };
      pr.net += r.netCents;
      pr.units += units;
      perRelease.set(s.releaseId!, pr);
      madeByMonth.set(monthOf(s.date), (madeByMonth.get(monthOf(s.date)) ?? 0) + r.netCents);
      if (!n.firstSale || s.date < n.firstSale) n.firstSale = s.date;
    }
    for (const e of approved) spentByMonth.set(monthOf(e.date), (spentByMonth.get(monthOf(e.date)) ?? 0) + e.amountCents);
    n.balance = n.madeBack - n.spent;

    const cats = new Map<string, number>();
    for (const e of approved) cats.set(e.category || "Other", (cats.get(e.category || "Other") ?? 0) + e.amountCents);
    n.byCategory = [...cats].map(([category, cents]) => ({ category, cents })).sort((a, b) => b.cents - a.cents);

    n.byRelease = [...releaseIds]
      .map((id) => {
        const info = releaseInfo.get(id);
        const pr = perRelease.get(id) ?? { net: 0, units: 0 };
        return { releaseId: id, title: info?.title ?? `#${id}`, kind: info?.kind ?? "album", artUrl: info?.artUrl ?? null, ...pr };
      })
      .sort((a, b) => b.net - a.net);

    const months = [...spentByMonth.keys(), ...madeByMonth.keys(), ...(p.startDate ? [monthOf(p.startDate)] : [])].sort();
    if (months.length) {
      let spent = 0;
      let made = 0;
      n.monthly = monthsBetween(months[0], thisMonth > months[months.length - 1] ? thisMonth : months[months.length - 1]).map((month) => {
        spent += spentByMonth.get(month) ?? 0;
        made += madeByMonth.get(month) ?? 0;
        return { month, spent, madeBack: made };
      });
    }
    out.set(p.id, n);
  }
  return out;
}
