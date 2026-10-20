import { connection } from "next/server";
import { ChartBoard } from "@/components/chart-board";
import { LabelFunds } from "@/components/label-funds";
import Link from "next/link";
import { buttonClass, Card, Empty, MoneyList, PageHeader } from "@/components/ui";
import { type BoardChart, breakdownChart, seriesChart } from "@/lib/chart-data";
import { formatCents } from "@/lib/money";
import { plural } from "@/lib/plural";
import { loadLayout } from "@/server/chart-layouts";
import { requireAccess } from "@/server/context";
import { nameMaps } from "@/server/data";
import { LABEL_RELEASES_SOURCE, labelIncome, SHIPPING_SOURCE, type Totals } from "@/server/label-income";

export const metadata = { title: "label funds" };

/** Sales listed on a page of "Where it came from". */
const PER_PAGE = 100;

/** "Where it came from" filters, from the URL. */
function incomeFilter(sp: Record<string, string | string[] | undefined>) {
  const one = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  };
  return { q: one("q"), from: one("from"), to: one("to"), source: one("source"), band: one("band"), page: Math.max(1, Number(one("page")) || 1) };
}

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
export default async function FundsPage({ searchParams }: PageProps<"/funds">) {
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

  // "Where it came from": every sale's part, newest first, filtered from the URL.
  const f = incomeFilter(await searchParams);
  const all = [...inc.lines].flatMap(([source, lines]) => lines.map((l) => ({ ...l, source })));
  const sourceNames = [...inc.lines.keys()].sort();
  const bandNames = [...new Set(all.map((l) => l.band))].sort();
  const needle = f.q?.toLowerCase();
  const shown = all
    .filter(
      (l) =>
        (!f.source || l.source === f.source) &&
        (!f.band || l.band === f.band) &&
        (!f.from || l.date >= f.from) &&
        (!f.to || l.date <= f.to) &&
        (!needle || l.item.toLowerCase().includes(needle)),
    )
    .sort((a, b) => b.date.localeCompare(a.date) || b.saleId - a.saleId);
  const shownTotal: Totals = new Map();
  for (const l of shown) shownTotal.set(l.currency, (shownTotal.get(l.currency) ?? 0) + l.cents);
  const filtered = !!(f.q || f.from || f.to || f.source || f.band);
  const pages = Math.max(1, Math.ceil(shown.length / PER_PAGE));
  const pageHref = (page: number) => {
    const p = new URLSearchParams(Object.entries({ q: f.q, from: f.from, to: f.to, source: f.source, band: f.band }).filter((e): e is [string, string] => !!e[1]));
    if (page > 1) p.set("page", String(page));
    return `/funds${p.size ? `?${p}` : ""}#came-from`;
  };

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
        <form action="/funds#came-from" id="came-from" className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-6">
          <input name="q" type="search" defaultValue={f.q} placeholder="Search sales" aria-label="Search sales" className="col-span-2" />
          <input name="from" type="date" defaultValue={f.from} aria-label="From" />
          <input name="to" type="date" defaultValue={f.to} aria-label="To" />
          <select name="source" defaultValue={f.source ?? ""} aria-label="Source">
            <option value="">Every source</option>
            {sourceNames.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
          <select name="band" defaultValue={f.band ?? ""} aria-label="Band">
            <option value="">Every band</option>
            {bandNames.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
          <div className="col-span-2 flex items-center gap-3 sm:col-span-6">
            <button type="submit" className={buttonClass("secondary", "sm")}>
              Show
            </button>
            {filtered && (
              <Link href="/funds#came-from" className="text-sm">
                Clear
              </Link>
            )}
            <span className="ml-auto text-sm text-muted">
              {plural(shown.length, "sale")} · <MoneyList totals={shownTotal} />
            </span>
          </div>
        </form>
        {shown.length === 0 ? (
          <Empty>{filtered ? "No sales match." : "Nothing yet."}</Empty>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="data">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th className="num">To the label</th>
                    <th>Source</th>
                    <th>Sale</th>
                    <th>Band</th>
                    <th className="num">Sale amount</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.slice((f.page - 1) * PER_PAGE, f.page * PER_PAGE).map((l, i) => (
                    <tr key={`${l.saleId}-${l.source}-${i}`}>
                      <td className="whitespace-nowrap text-muted">{l.date}</td>
                      <td className="num font-medium">{formatCents(l.cents, l.currency)}</td>
                      <td className="text-sm">{l.source}</td>
                      <td>{l.item || <span className="text-muted">(no name)</span>}</td>
                      <td className="text-sm">{l.band}</td>
                      <td className="num text-muted">{formatCents(l.saleCents, l.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pages > 1 && (
              <div className="mt-3 flex items-center gap-3 text-sm">
                {f.page > 1 && <Link href={pageHref(f.page - 1)}>← Newer</Link>}
                <span className="text-muted">
                  Page {f.page} of {pages}
                </span>
                {f.page < pages && <Link href={pageHref(f.page + 1)}>Older →</Link>}
              </div>
            )}
          </>
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
