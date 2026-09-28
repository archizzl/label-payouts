import Link from "next/link";
import { SALES_RANGES, salesRangeDates } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { getContext } from "@/server/context";
import { salesReport } from "@/server/sales-report";
import { BarList, MonthlyColumns, type Segment, StackedBar } from "./charts";
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
    report.toPeople + report.label + report.bandFund + report.costs + report.unallocated + report.bandcampShare + report.processorFee + report.marketplaceTax;
  const other = report.gross - accounted;
  const segments: Segment[] = [
    { key: "people", label: "Paid to people", value: report.toPeople, color: "var(--series-1)" },
    { key: "label", label: "Label", value: report.label, color: "var(--series-2)" },
    { key: "fund", label: "Band fund", value: report.bandFund, color: "var(--series-3)" },
    { key: "costs", label: "Costs withheld", value: report.costs, color: "var(--series-4)" },
    { key: "bandcamp", label: "Bandcamp’s share", value: report.bandcampShare, color: "var(--series-5)" },
    { key: "processing", label: "Payment processing", value: report.processorFee, color: "var(--series-6)" },
    { key: "tax", label: "Sales tax (remitted by Bandcamp)", value: report.marketplaceTax, color: "var(--series-7)" },
    { key: "held", label: "Held back (not assigned yet)", value: report.unallocated, color: "var(--series-8)" },
    ...(Math.abs(other) > 1 ? [{ key: "other", label: "Other / rounding", value: other, color: "var(--muted)" }] : []),
  ];
  const hasSources = report.bySource.some((s) => s.key !== "Direct / unknown");

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
          {!readOnly && (
            <>
              <Link href="/import">Import a sales report</Link> to see them here.
            </>
          )}
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

          {report.byMonth.length > 1 && (
            <div>
              <h3 className="mb-2 text-sm font-bold">net received by month</h3>
              <MonthlyColumns data={report.byMonth} currency={cur} />
              <details className="mt-1 text-xs">
                <summary className="text-link">show as a table</summary>
                <table className="data mt-2">
                  <thead>
                    <tr>
                      <th>month</th>
                      <th className="num">items</th>
                      <th className="num">net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byMonth.map((m) => (
                      <tr key={m.month}>
                        <td>{m.month}</td>
                        <td className="num">{m.units}</td>
                        <td className="num">
                          <Money cents={m.net} currency={cur} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </div>
          )}

          <div className={`grid gap-8 ${hasSources ? "md:grid-cols-2" : ""}`}>
            <div>
              <h3 className="mb-2 text-sm font-bold">by format</h3>
              <BarList data={report.byFormat} currency={cur} total={report.net} />
            </div>
            {hasSources ? (
              <div>
                <h3 className="mb-2 text-sm font-bold">by source</h3>
                <BarList data={report.bySource} currency={cur} total={report.net} />
              </div>
            ) : null}
          </div>
          {!hasSources && <p className="-mt-6 text-xs text-muted">Your sales reports don’t say where fans came from, so there’s no breakdown by source.</p>}

          <div>
            <h3 className="mb-1 text-sm font-bold">where the money went</h3>
            <p className="mb-3 text-xs text-muted">Of the {formatCents(report.gross, cur)} fans paid.</p>
            <StackedBar
              segments={segments}
              currency={cur}
              footer={
                report.shipping > 0 ? (
                  <p className="mt-2 text-xs text-muted">
                    Includes {formatCents(report.shipping, cur)} of shipping fans paid, which is part of what was received.
                  </p>
                ) : null
              }
            />
          </div>

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
                      <th className="num">− fees &amp; tax</th>
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
                  Digital and physical are what fans paid (physical includes shipping). Fees &amp; tax are Bandcamp’s share, payment
                  processing and any sales tax Bandcamp collected. To people is net after the label’s cut, band funds and costs.
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
