import Link from "next/link";
import { connection } from "next/server";
import { ChartBoard } from "@/components/chart-board";
import { LabelFunds } from "@/components/label-funds";
import { Card, Empty, PageHeader } from "@/components/ui";
import { type BoardChart, breakdownChart, seriesChart } from "@/lib/chart-data";
import { formatCents } from "@/lib/money";
import { plural } from "@/lib/plural";
import { loadLayout } from "@/server/chart-layouts";
import { requireAccess } from "@/server/context";
import { nameMaps } from "@/server/data";
import { LABEL_RELEASES_SOURCE, labelIncome, SHIPPING_SOURCE, type Totals } from "@/server/label-income";

export const metadata = { title: "label funds" };

/** Sales listed under each source; the rest are counted. */
const LINES_SHOWN = 100;

/** Why each source of label money is there, in a few words. */
function explain(source: string) {
  if (source === SHIPPING_SOURCE) return "";
  if (source === LABEL_RELEASES_SOURCE) return "releases under the label’s own name without a split";
  return "a withholding kept by the label";
}

/**
 * The label's own money: where it comes from (each withholding, its own releases, shipping), when
 * and from which bands, what went out (sent on, spent), and what's left in its account.
 */
export default async function FundsPage() {
  await connection();
  const ctx = await requireAccess("funds");
  // A band's own account: what the label sent on from its money.
  if (ctx.lens) {
    return (
      <>
        <PageHeader title="Label funds" />
        <LabelFunds bandId={ctx.managedBy!.bandId} />
      </>
    );
  }
  const { orgId } = ctx;
  const [inc, names] = await Promise.all([labelIncome(orgId), nameMaps(orgId)]);
  const cur = inc.currencies[0] ?? "USD";
  const v = (m: Totals) => m.get(cur) ?? 0;
  const rows = (m: Map<string, Totals>) =>
    [...m]
      .map(([key, t]) => ({ key, net: t.get(cur) ?? 0, units: 0 }))
      .filter((r) => r.net !== 0)
      .sort((a, b) => b.net - a.net);
  const sources = rows(inc.bySource).map((r) => {
    const sent = Math.max(0, inc.sentBySource.get(r.key)?.get(cur) ?? 0);
    return { key: r.key, explain: explain(r.key), net: r.net, sent, held: r.net - sent };
  });
  // Shares are of what the label still holds: money already sent on doesn't count.
  const totalHeld = sources.reduce((a, x) => a + Math.max(0, x.held), 0);
  const bands = rows(inc.byBand);
  const byMonth = inc.trends.source.months.map((month) => ({ month, value: inc.byMonth.get(month)?.get(cur) ?? 0 }));

  // The customizable charts.
  const charts: BoardChart[] = [
    {
      spec: { kind: "sources", title: "", shape: "held-sent", wide: true },
      data: { shape: "held-sent", currency: cur, total: totalHeld, rows: sources },
    },
    seriesChart("month", "By month", byMonth, { currency: cur }),
    breakdownChart("band", "By band", bands, { currency: cur, total: v(inc.income), share: "of the label’s money", showUnits: false, trend: inc.trends.band }),
    breakdownChart(
      "source-trend",
      "Sources over time",
      sources.map((x) => ({ key: x.key, net: x.net })),
      { currency: cur, total: v(inc.income), share: "of the label’s money", showUnits: false, trend: inc.trends.source },
    ),
  ];
  // "Sources over time" starts out as a line chart.
  charts[3].spec.formats = ["line", ...(charts[3].spec.formats ?? []).filter((f) => f !== "line")];
  const saved = await loadLayout("funds");

  return (
    <>
      <PageHeader title="Label funds"/>

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Tile label="Left in the label’s account" cents={v(inc.balance)} currency={cur} emphasis />
        <Tile label="Came in to the label" cents={v(inc.income)} currency={cur} />
        <Tile label="Sent on to others" cents={-v(inc.sent) || 0} currency={cur} />
        <Tile label="Spent on expenses" cents={-v(inc.spent) || 0} currency={cur} hint={<Link href="/receipts">receipts</Link>} />
      </div>
      {inc.currencies.length > 1 && (
        <p className="-mt-3 mb-6 text-xs text-muted">
          Shown in {cur}. Also: {inc.currencies.slice(1).map((c) => `${formatCents(inc.income.get(c) ?? 0, c)} came in`).join(", ")} (currencies
          aren’t converted).
        </p>
      )}

      <ChartBoard boardId="funds" charts={charts} saved={saved} />

      <Card title="Where it came from">
        {sources.length === 0 ? (
          <Empty>Nothing yet.</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {sources.map((x) => {
              const lines = (inc.lines.get(x.key) ?? []).filter((l) => l.currency === cur);
              return (
                <li key={x.key} className="py-2">
                  <details>
                    <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3">
                      <span className="font-medium">{x.key}</span>
                      <span className="text-sm text-muted">{plural(lines.length, "sale")}</span>
                      <span className="ml-auto font-medium tabular-nums">{formatCents(x.net, cur)}</span>
                    </summary>
                    <div className="mt-2 overflow-x-auto">
                      <table className="data">
                        <thead>
                          <tr>
                            <th>Date</th>
                            <th>Sale</th>
                            <th>Band</th>
                            <th className="num">Sale</th>
                            <th className="num">To the label</th>
                          </tr>
                        </thead>
                        <tbody>
                          {lines.slice(0, LINES_SHOWN).map((l, i) => (
                            <tr key={`${l.saleId}-${i}`}>
                              <td className="whitespace-nowrap text-muted">{l.date}</td>
                              <td>{l.item || <span className="text-muted">(no name)</span>}</td>
                              <td className="text-sm">{l.band}</td>
                              <td className="num text-muted">{formatCents(l.saleCents, l.currency)}</td>
                              <td className="num">{formatCents(l.cents, l.currency)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {lines.length > LINES_SHOWN && <p className="mt-2 text-xs text-muted">And {plural(lines.length - LINES_SHOWN, "earlier sale")}.</p>}
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <LabelFunds showTotals={false} />

      <Card title="Spent on expenses" actions={<Link href="/receipts" className="text-sm">receipts</Link>}>
        {inc.spending.length === 0 ? (
          <p className="text-sm text-muted">Nothing yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>For</th>
                  <th>Paid to</th>
                  <th className="num">Amount</th>
                  <th>How</th>
                </tr>
              </thead>
              <tbody>
                {[...inc.spending]
                  .map((e) => ({ e, when: (e.paidBy === "person" ? e.reimbursedAt?.slice(0, 10) : null) ?? e.date }))
                  .sort((a, b) => b.when.localeCompare(a.when) || b.e.id - a.e.id)
                  .map(({ e, when }) => (
                    <tr key={e.id}>
                      <td className="whitespace-nowrap text-muted">{when}</td>
                      <td>
                        {e.description}
                        {e.bandId && <div className="text-xs text-muted">{names.band.get(e.bandId)}</div>}
                      </td>
                      <td className="text-sm">
                        {e.paidBy === "person" ? (
                          <>
                            {names.person.get(e.paidByPersonId ?? 0) ?? "Someone"}
                            <div className="text-xs text-muted">paid back for a receipt</div>
                          </>
                        ) : (
                          (e.vendor ?? <span className="text-muted">—</span>)
                        )}
                      </td>
                      <td className="num font-medium">{formatCents(e.amountCents, e.currency)}</td>
                      <td className="text-xs text-muted">{[e.reimbursedMethod, e.reimbursedReference].filter(Boolean).join(" · ") || "—"}</td>
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
