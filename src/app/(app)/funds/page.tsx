import Link from "next/link";
import { connection } from "next/server";
import { BarList, MonthlyColumns } from "@/components/charts";
import { LabelFunds } from "@/components/label-funds";
import { Card, PageHeader } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { requireAdmin } from "@/server/context";
import { LABEL_RELEASES_SOURCE, labelIncome, SHIPPING_SOURCE, type Totals } from "@/server/label-income";

/** Why each source of label money is there, in a few words. */
function explain(source: string) {
  if (source === SHIPPING_SOURCE) return "what fans paid for shipping; never split, it pays for postage";
  if (source === LABEL_RELEASES_SOURCE) return "releases under the label’s own name without a split";
  return "a withholding kept by the label (see Label rules or the band’s page)";
}

/**
 * The label's own money: where it comes from (each withholding, its own releases, shipping), when
 * and from which bands, what went out (sent on, spent), and what's left in its account.
 */
export default async function FundsPage() {
  await connection();
  const { orgId } = await requireAdmin();
  const inc = await labelIncome(orgId);
  const cur = inc.currencies[0] ?? "USD";
  const v = (m: Totals) => m.get(cur) ?? 0;
  const rows = (m: Map<string, Totals>) =>
    [...m]
      .map(([key, t]) => ({ key, net: t.get(cur) ?? 0, units: 0 }))
      .filter((r) => r.net !== 0)
      .sort((a, b) => b.net - a.net);
  const sources = rows(inc.bySource);
  const bands = rows(inc.byBand);
  const months = [...inc.byMonth.keys()].sort();
  const byMonth: { month: string; net: number; units: number }[] = [];
  if (months.length) {
    let [y, m] = months[0].split("-").map(Number);
    for (let k = months[0]; k <= months[months.length - 1]; ) {
      byMonth.push({ month: k, net: inc.byMonth.get(k)?.get(cur) ?? 0, units: 0 });
      m++;
      if (m > 12) [y, m] = [y + 1, 1];
      k = `${y}-${String(m).padStart(2, "0")}`;
    }
  }

  return (
    <>
      <PageHeader title="Label funds" subtitle="The label’s own money: where it comes from, where it went, and what’s left." />

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Tile label="Came in to the label" cents={v(inc.income)} currency={cur} />
        <Tile label="Sent on to others" cents={-v(inc.sent) || 0} currency={cur} />
        <Tile label="Spent on expenses" cents={-v(inc.spent) || 0} currency={cur} hint={<Link href="/receipts">receipts</Link>} />
        <Tile label="Left in the label’s account" cents={v(inc.balance)} currency={cur} emphasis />
      </div>
      {v(inc.holderShare) !== 0 && (
        <p className="-mt-3 mb-6 text-sm text-muted">
          The account also holds {formatCents(v(inc.holderShare), cur)} that’s {inc.holderName ? `${inc.holderName}’s` : "the account holder’s"} own share
          of sales, kept there instead of being paid out. It isn’t counted as the label’s.
        </p>
      )}
      {inc.currencies.length > 1 && (
        <p className="-mt-3 mb-6 text-xs text-muted">
          Shown in {cur}. Also: {inc.currencies.slice(1).map((c) => `${formatCents(inc.income.get(c) ?? 0, c)} came in`).join(", ")} (currencies
          aren’t converted).
        </p>
      )}

      <Card title="Where the label’s money comes from">
        {sources.length === 0 ? (
          <p className="text-sm text-muted">Nothing yet.</p>
        ) : (
          <ul className="space-y-3">
            {sources.map((src) => {
              const max = Math.max(...sources.map((x) => x.net));
              return (
                <li key={src.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 text-sm sm:grid-cols-[minmax(0,16rem)_1fr_auto]">
                  <div>
                    <div className="font-medium">{src.key}</div>
                    <div className="text-xs text-muted">{explain(src.key)}</div>
                  </div>
                  <span className="order-last col-span-2 mt-1 h-3 sm:order-none sm:col-span-1 sm:mt-1">
                    <span className="block h-3 rounded-r-[4px] bg-chart-accent" style={{ width: `${Math.max(0, (src.net / max) * 100)}%`, minWidth: 2 }} />
                  </span>
                  <div className="text-right tabular-nums">
                    {formatCents(src.net, cur)}
                    <div className="text-xs text-muted">{v(inc.income) ? `${((src.net / v(inc.income)) * 100).toFixed(1)}%` : ""}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        {byMonth.length > 1 && (
          <Card title="By month">
            <MonthlyColumns data={byMonth} currency={cur} label="The label’s money by month" />
          </Card>
        )}
        {bands.length > 0 && (
          <Card title="By band">
            <BarList data={bands} currency={cur} total={v(inc.income)} share="of the label’s money" showUnits={false} />
          </Card>
        )}
      </div>

      <LabelFunds showTotals={false} />
    </>
  );
}

function Tile({ label, cents, currency, emphasis, hint }: { label: string; cents: number; currency: string; emphasis?: boolean; hint?: React.ReactNode }) {
  return (
    <div className={`border bg-surface px-4 py-3 ${emphasis ? "border-accent" : "border-border"}`}>
      <div className={`text-2xl font-bold tabular-nums ${emphasis ? "text-accent" : ""}`}>{formatCents(cents, currency)}</div>
      <div className="text-xs text-muted">
        {label}
        {hint && <> · {hint}</>}
      </div>
    </div>
  );
}
