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
  const sources = rows(inc.bySource).map((r) => {
    const sent = Math.max(0, inc.sentBySource.get(r.key)?.get(cur) ?? 0);
    return { ...r, sent, held: r.net - sent };
  });
  // Sources whose money has all been sent on are tucked away.
  const done = sources.filter((r) => r.sent > 0 && r.held <= 0);
  const open = sources.filter((r) => !done.includes(r));
  const max = Math.max(1, ...sources.map((x) => Math.max(x.net, x.sent)));
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
          <>
            <ul className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted" aria-label="Legend">
              <li className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: HELD }} />
                Still held by the label
              </li>
              <li className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: SENT }} />
                Sent on
              </li>
            </ul>
            <SourceRows rows={open} max={max} total={v(inc.income)} currency={cur} />
            {done.length > 0 && (
              <details className="mt-4">
                <summary className="cursor-pointer text-sm text-link">
                  {done.length} source{done.length === 1 ? "" : "s"} fully sent on
                </summary>
                <div className="mt-3">
                  <SourceRows rows={done} max={max} total={v(inc.income)} currency={cur} />
                </div>
              </details>
            )}
          </>
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

const HELD = "var(--series-1)";
const SENT = "var(--series-2)";

type SourceRow = { key: string; net: number; sent: number; held: number };

/** One row per source: a bar split into still held and sent on, on a shared scale. */
function SourceRows({ rows, max, total, currency }: { rows: SourceRow[]; max: number; total: number; currency: string }) {
  return (
    <ul className="space-y-3">
      {rows.map((src) => {
        const held = Math.max(0, src.held);
        return (
          <li key={src.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 text-sm sm:grid-cols-[minmax(0,16rem)_1fr_auto]">
            <div>
              <div className="font-medium">{src.key}</div>
              <div className="text-xs text-muted">{explain(src.key)}</div>
            </div>
            <span
              className="order-last col-span-2 mt-1 flex h-3 gap-[2px] sm:order-none sm:col-span-1"
              role="img"
              aria-label={`${src.key}: ${formatCents(held, currency)} still held, ${formatCents(src.sent, currency)} sent on`}
            >
              {held > 0 && (
                <span
                  className={`block h-3 ${src.sent > 0 ? "" : "rounded-r-[4px]"}`}
                  style={{ width: `${(held / max) * 100}%`, minWidth: 2, background: HELD }}
                  title={`Still held: ${formatCents(held, currency)}`}
                />
              )}
              {src.sent > 0 && (
                <span
                  className="block h-3 rounded-r-[4px]"
                  style={{ width: `${(src.sent / max) * 100}%`, minWidth: 2, background: SENT }}
                  title={`Sent on: ${formatCents(src.sent, currency)}`}
                />
              )}
            </span>
            <div className="text-right tabular-nums">
              {formatCents(src.net, currency)}
              <div className="text-xs text-muted">{total ? `${((src.net / total) * 100).toFixed(1)}% of the label’s money` : ""}</div>
              {src.sent > 0 && (
                <div className="text-xs text-muted">
                  {formatCents(held, currency)} held · {formatCents(src.sent, currency)} sent on
                  {src.held < 0 && ` (${formatCents(-src.held, currency)} more than it brought in)`}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
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
