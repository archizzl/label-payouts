import Link from "next/link";
import { SALES_RANGES, salesRangeDates } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { getContext } from "@/server/context";
import { salesReport } from "@/server/sales-report";
import { type BoardChart, breakdownChart, seriesChart } from "@/lib/chart-data";
import type { ChartFormat } from "@/lib/chart-layout";
import { loadLayout } from "@/server/chart-layouts";
import { ChartBoard } from "./chart-board";
import type { Segment } from "./charts";
import { Card, Money } from "./ui";

/**
 * Sales for a band (every release and merch item) or for one release/item: headline numbers,
 * net by month, by format and by source, where the money went (fees, label, band, people), and
 * — for a band — a per-item table. The range links scope everything in the section.
 */
export async function SalesSection({
  scope,
  range,
  basePath,
  showItems = false,
  readOnly = false,
  title = "Sales",
  orgId: fromOrg,
  boardId,
}: {
  scope: { bandId?: number; releaseId?: number };
  range?: string;
  /** The page's own path, for the range links. */
  basePath: string;
  showItems?: boolean;
  /** For members: no links into the admin pages. */
  readOnly?: boolean;
  title?: string;
  /** Read another account's books (a label linked to this band account). Callers check access. */
  orgId?: string;
  /** Which chart layout this is (each person arranges a band page's charts separately from a release page's…). */
  boardId: string;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const r = salesRangeDates(range, today);
  const orgId = fromOrg ?? (await getContext()).orgId;
  const report = await salesReport(orgId, { ...scope, from: r.from, to: r.to });
  const cur = report.currency ?? "USD";
  const fees = report.bandcampShare + report.processorFee;
  // Everything fans paid, split by where it ended up. Any gap (e.g. a fee column we don't read)
  // shows as its own segment rather than being hidden.
  const accounted =
    report.toPeople +
    report.label +
    report.shipping +
    report.bandFund +
    report.costs +
    report.unallocated +
    report.bandcampShare +
    report.processorFee +
    report.marketplaceTax;
  const other = report.gross - accounted;
  const segments: Segment[] = [
    { key: "people", label: "Paid to people", value: report.toPeople, color: "var(--series-1)" },
    // Shipping isn't split: it stays with the label, for postage.
    { key: "label", label: report.shipping ? "Label (incl. shipping)" : "Label", value: report.label + report.shipping, color: "var(--series-2)" },
    { key: "fund", label: "Band fund", value: report.bandFund, color: "var(--series-3)" },
    { key: "costs", label: "Costs withheld", value: report.costs, color: "var(--series-4)" },
    { key: "bandcamp", label: "Bandcamp’s share", value: report.bandcampShare, color: "var(--series-5)" },
    { key: "processing", label: "Payment processing", value: report.processorFee, color: "var(--series-6)" },
    { key: "tax", label: "Sales tax (remitted by Bandcamp)", value: report.marketplaceTax, color: "var(--series-7)" },
    { key: "held", label: "Held back (not assigned yet)", value: report.unallocated, color: "var(--series-8)" },
    ...(Math.abs(other) > 1 ? [{ key: "other", label: "Other / rounding", value: other, color: "var(--muted)" }] : []),
  ];
  const hasSources = report.bySource.some((s) => s.key !== "Direct / unknown");

  // The charts, customizable per person.
  const charts: BoardChart[] = [
    seriesChart("month", "Net received by month", report.byMonth.map((m) => ({ month: m.month, value: m.net, units: m.units })), { currency: cur }),
    breakdownChart("format", "By format", report.byFormat, { currency: cur, total: report.net, trend: report.trends.format }),
    breakdownChart("source", "By source", report.bySource, { currency: cur, total: report.net, trend: report.trends.source }),
    {
      spec: { kind: "money-went", title: "Where the money went", shape: "parts", wide: true },
      data: {
        shape: "parts",
        currency: cur,
        segments,
        caption: `Of the ${formatCents(report.gross, cur)} fans paid.`,
        note: report.shipping > 0 ? `The label’s part includes ${formatCents(report.shipping, cur)} of shipping fans paid. Shipping isn’t split: it stays with the label, for postage.` : undefined,
      },
    },
  ];
  const defaults: [string, ChartFormat?][] = [
    ...(report.byMonth.length > 1 ? [["month"] as [string]] : []),
    ["format"],
    ...(hasSources ? [["source"] as [string]] : []),
    ["money-went"],
  ];
  const saved = await loadLayout(boardId);

  return (
    <Card
      title={title}
      actions={
        <nav className="flex flex-wrap gap-3 text-xs" aria-label="Date range">
          {SALES_RANGES.map((o) => (
            <Link
              key={o.key}
              href={o.key === "all" ? basePath : `${basePath}?range=${o.key}`}
              scroll={false}
              className={`border-b-2 pb-0.5 hover:no-underline ${r.key === o.key ? "border-accent font-bold text-text" : "border-transparent text-muted hover:text-text"}`}
            >
              {o.label}
            </Link>
          ))}
        </nav>
      }
    >
      {report.saleCount === 0 ? (
        <p className="text-sm text-muted">
          No sales {r.key === "all" ? "yet" : "in this range"}.{" "}
          {/* {!readOnly && (
            <>
              <Link href="/sales/import">Import a sales report</Link> to see them here.
            </>
          )} */}
        </p>
      ) : (
        <div className="space-y-8">
          {/* Headline numbers */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-5">
            <Figure label="Net received" value={<Money cents={report.net} currency={cur} />} hint="after Bandcamp and payment fees" strong />
            <Figure label="Fans paid" value={<Money cents={report.gross} currency={cur} />} hint="incl. shipping and tax" />
            <Figure label="Items sold" value={report.units.toLocaleString()} hint={`${report.saleCount} sale${report.saleCount === 1 ? "" : "s"}`} />
            <Figure
              label="Fees"
              value={<Money cents={fees} currency={cur} />}
              hint={report.gross ? `${((fees / report.gross) * 100).toFixed(1)}% of what fans paid` : undefined}
            />
            <Figure label="Paid above price" value={<Money cents={report.fanExtra} currency={cur} />} hint="fans choosing to pay more" />
          </div>
          {report.otherCurrencies.length > 0 && (
            <p className="-mt-4 text-xs text-muted">
              Showing {cur} only. Also sold in {report.otherCurrencies.map((c) => formatCents(c.net, c.currency)).join(", ")} (currencies aren’t
              converted).
            </p>
          )}

          <ChartBoard boardId={boardId} charts={charts} defaults={defaults} saved={saved} plain />

          {showItems && report.items.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-bold">by release and item</h3>
              <div className="overflow-x-auto">
                <table className="data">
                  <thead>
                    <tr>
                      <th>item</th>
                      <th className="num">sold</th>
                      <th className="num">digital</th>
                      <th className="num">physical / merch</th>
                      <th className="num">= fans paid</th>
                      <th className="num">− fees, tax &amp; shipping</th>
                      <th className="num">= net</th>
                      <th className="num">to people</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.items.map((it) => (
                      <tr key={`${it.releaseId ?? it.title}`}>
                        <td>
                          <div className="flex items-center gap-2.5">
                            {it.artUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={it.artUrl.replace(/_(10|16)\.jpg$/, "_3.jpg")} alt="" loading="lazy" className="h-6 w-6 shrink-0 border border-border bg-surface-2 object-cover" />
                            ) : (
                              <span className="h-6 w-6 shrink-0 bg-surface-2" />
                            )}
                            {it.releaseId && !readOnly ? <Link href={`/catalog/${it.releaseId}`}>{it.title}</Link> : <span>{it.title}</span>}
                            <span className="text-xs text-muted">{it.kind === "unmatched" ? "not in catalog" : it.kind === "track" ? "single" : it.kind === "merch" ? "merch" : ""}</span>
                          </div>
                        </td>
                        <td className="num">{it.units}</td>
                        <td className="num text-muted">{it.digitalGross ? <Money cents={it.digitalGross} currency={cur} /> : "—"}</td>
                        <td className="num text-muted">{it.physicalGross ? <Money cents={it.physicalGross} currency={cur} /> : "—"}</td>
                        <td className="num">
                          <Money cents={it.gross} currency={cur} />
                        </td>
                        <td className="num text-muted">
                          <Money cents={-it.feesAndTax} currency={cur} />
                        </td>
                        <td className="num font-bold">
                          <Money cents={it.net} currency={cur} />
                        </td>
                        <td className="num">
                          <Money cents={it.toPeople} currency={cur} />
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td className="font-bold">Total</td>
                      <td className="num font-bold">{report.units}</td>
                      <td className="num text-muted">
                        <Money cents={report.items.reduce((a, i) => a + i.digitalGross, 0)} currency={cur} />
                      </td>
                      <td className="num text-muted">
                        <Money cents={report.items.reduce((a, i) => a + i.physicalGross, 0)} currency={cur} />
                      </td>
                      <td className="num font-bold">
                        <Money cents={report.gross} currency={cur} />
                      </td>
                      <td className="num text-muted">
                        <Money cents={-report.items.reduce((a, i) => a + i.feesAndTax, 0)} currency={cur} />
                      </td>
                      <td className="num font-bold">
                        <Money cents={report.net} currency={cur} />
                      </td>
                      <td className="num font-bold">
                        <Money cents={report.toPeople} currency={cur} />
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p className="mt-2 text-xs text-muted">
                  Digital and physical are what fans paid (physical includes shipping). Fees, tax &amp; shipping are Bandcamp’s share,
                  payment processing, any sales tax Bandcamp collected, and shipping (which stays with the label, for postage). Net is
                  what gets split; to people is net after the label’s cut, band funds and costs.
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function Figure({ label, value, hint, strong }: { label: string; value: React.ReactNode; hint?: string; strong?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className={`mt-0.5 font-bold ${strong ? "text-2xl" : "text-xl"}`}>{value}</div>
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </div>
  );
}
