import { and, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { ChartBoard } from "@/components/chart-board";
import { SalesTabs } from "@/components/sales-tabs";
import { Badge, buttonClass, Card, Empty, Money, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { type BoardChart, breakdownChart, seriesChart } from "@/lib/chart-data";
import type { ChartFormat } from "@/lib/chart-layout";
import { formatCents } from "@/lib/money";
import { loadLayout } from "@/server/chart-layouts";
import { bandScope, can } from "@/lib/permissions";
import { requireAccess } from "@/server/context";
import {
  browseSales,
  filterQuery,
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
  parseSalesFilter,
  type SalesFilter,
  type SortKey,
  salesFilterOptions,
  summarizeSales,
} from "@/server/sales-browse";

const TYPE_LABEL: Record<string, string> = { album: "Album", track: "Track", merch: "Merch", other: "Other" };

/** Every sale, filterable and sortable, with totals and breakdowns of what's filtered. */
export default async function SalesPage({ searchParams }: PageProps<"/sales">) {
  await connection();
  const { orgId, access } = await requireAccess("sales");
  // A member type can limit this to their own bands' sales.
  const scope = bandScope(access, "sales");
  const f = { ...parseSalesFilter(await searchParams), onlyBands: scope ?? undefined };
  const [page, summary, options, [{ unrouted }]] = await Promise.all([
    browseSales(orgId, f),
    summarizeSales(orgId, f),
    salesFilterOptions(orgId, scope ?? undefined),
    db
      .select({ unrouted: db.$count(schema.sales, and(eq(schema.sales.orgId, orgId), isNull(schema.sales.bandId))) })
      .from(schema.organization)
      .where(eq(schema.organization.id, orgId)),
  ]);
  const filtered = !!(
    f.q ||
    f.from ||
    f.to ||
    f.band ||
    f.release ||
    f.type ||
    f.country !== undefined ||
    f.source !== undefined ||
    f.currency ||
    f.refunds ||
    f.payout ||
    f.buyer
  );
  const main = summary.totals[0];
  const pages = Math.max(1, Math.ceil(page.count / f.per));
  const cur = summary.main;

  // The customizable charts under the list: what's available, and what's shown until someone changes it.
  const net = main?.net ?? 0;
  const typeLabel = (k: string) => TYPE_LABEL[k] ?? k;
  const charts: BoardChart[] = [
    seriesChart("month", "Net received by month", summary.byMonth.map((m) => ({ month: m.month, value: m.net, units: m.units })), { currency: cur }),
    breakdownChart("item", "Top items", summary.byItem, {
      currency: cur,
      total: net,
      trend: summary.trends.item,
      links: summary.byItem.slice(0, 3).map((r) => ({ label: r.key, href: filterQuery(f, { q: r.key, page: 1 }) || "/sales" })),
    }),
    breakdownChart("band", "By band", summary.byBand, { currency: cur, total: net, trend: summary.trends.band }),
    breakdownChart("type", "By type", summary.byType.map((r) => ({ ...r, key: typeLabel(r.key) })), {
      currency: cur,
      total: net,
      trend: { ...summary.trends.type, series: summary.trends.type.series.map((x) => ({ ...x, key: typeLabel(x.key) })) },
    }),
    breakdownChart("country", "By country", summary.byCountry, { currency: cur, total: net, trend: summary.trends.country }),
    breakdownChart("source", "Where fans came from", summary.bySource, { currency: cur, total: net, trend: summary.trends.source }),
  ];
  const defaults: [string, ChartFormat?][] = [
    ...(summary.byMonth.length > 1 ? [["month"] as [string]] : []),
    ["item"],
    ...(!f.band ? [["band"] as [string]] : []),
    ...(!f.type ? [["type"] as [string]] : []),
    ...(f.country === undefined ? [["country"] as [string]] : []),
    ...(f.source === undefined && summary.bySource.some((x) => x.key !== "Direct / unknown") ? [["source"] as [string]] : []),
  ];
  const saved = await loadLayout("sales");

  return (
    <>
      <PageHeader
        title="Sales"
        subtitle="Every sale. Filter, sort and dig in; the totals and charts follow your filters."
        actions={
          page.count > 0 && (
            <a href={`/sales/export${filterQuery(f, { page: 1 })}`} className={buttonClass("secondary")} download>
              Export CSV
            </a>
          )
        }
      />
      <SalesTabs active="browse" unrouted={unrouted} canImport={can(access, "sales", "edit")} />

      <Card title={main ? `${page.count.toLocaleString("en-US")} sale${page.count === 1 ? "" : "s"}` : "Sales"}>
        <Filters f={f} options={options} filtered={filtered} />
        {f.buyer && (
          <p className="mb-3 text-sm">
            Showing one buyer’s sales. <Link href={filterQuery(f, { buyer: undefined, page: 1 }) || "/sales"}>Show everyone’s</Link>
          </p>
        )}
        {!main ? (
          <Empty>
            {filtered ? (
              <>
                No sales match. <Link href="/sales">Clear the filters</Link>.
              </>
            ) : (
              <>
                No sales yet. <Link href="/sales/import">Import or sync them from Bandcamp</Link>.
              </>
            )}
          </Empty>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="data">
                <thead>
                  <tr>
                    <SortHeader f={f} k="date" label="Date" />
                    <SortHeader f={f} k="item" label="Item" />
                    <SortHeader f={f} k="band" label="Band" />
                    <SortHeader f={f} k="type" label="Type" />
                    <SortHeader f={f} k="country" label="Country" />
                    <SortHeader f={f} k="source" label="From" />
                    <SortHeader f={f} k="qty" label="Qty" num />
                    <SortHeader f={f} k="net" label="Net" num />
                    <SortHeader f={f} k="payout" label="Paid out" />
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((s) => (
                    <tr key={s.id} className="align-top">
                      <td className="whitespace-nowrap text-muted">{s.date}</td>
                      <td className="min-w-48">
                        <details>
                          <summary className="cursor-pointer">
                            {s.itemName || <span className="text-muted">(no name)</span>}
                            {s.packageName && <span className="text-xs text-muted"> · {s.packageName}</span>}
                          </summary>
                          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                            {Object.entries(s.raw)
                              .filter(([k]) => !["item name", "date"].includes(k))
                              .map(([k, v]) => (
                                <div key={k} className="contents">
                                  <dt className="text-muted">{k}</dt>
                                  <dd className="break-all">{v}</dd>
                                </div>
                              ))}
                          </dl>
                          {s.buyerKey ? (
                            <p className="mt-1 text-xs">
                              <span className="text-muted">buyer </span>
                              {s.fanEmail ? `${s.fanName ? `${s.fanName} · ` : ""}${s.fanEmail} (on your mailing list)` : "not on your mailing list"}
                              {s.buyerSales > 1 && !f.buyer && (
                                <>
                                  {" · "}
                                  <Link href={filterQuery({ ...f, q: undefined }, { buyer: s.buyerKey, page: 1 })}>all {s.buyerSales} sales to this buyer</Link>
                                </>
                              )}
                            </p>
                          ) : null}
                          {s.releaseId && (
                            <Link href={`/catalog/${s.releaseId}`} className="mt-1 inline-block text-xs">
                              {s.releaseTitle ?? "Release"} in the catalog →
                            </Link>
                          )}
                        </details>
                      </td>
                      <td className="text-sm">
                        {s.bandId ? (
                          <Link href={filterQuery(f, { band: s.bandId, page: 1 }) || "?"} className="hover:underline">
                            {s.bandName}
                          </Link>
                        ) : (
                          <Link href="/sales/import" className="text-bad">
                            not matched
                          </Link>
                        )}
                        {s.artist && s.artist !== s.bandName && <div className="text-xs text-muted">{s.artist}</div>}
                      </td>
                      <td className="text-sm">
                        <Link href={filterQuery(f, { type: s.category, page: 1 })} className="text-text hover:underline">
                          {TYPE_LABEL[s.category] ?? s.category}
                        </Link>
                      </td>
                      <td className="text-sm">
                        {s.country ? (
                          <Link href={filterQuery(f, { country: s.country, page: 1 })} className="text-text hover:underline">
                            {s.country}
                          </Link>
                        ) : (
                          <span className="text-muted">–</span>
                        )}
                      </td>
                      <td className="max-w-40 truncate text-sm" title={s.source}>
                        {s.source ? (
                          <Link href={filterQuery(f, { source: s.source, page: 1 })} className="text-text hover:underline">
                            {s.source}
                          </Link>
                        ) : (
                          <span className="text-muted">–</span>
                        )}
                      </td>
                      <td className="num">{s.quantity}</td>
                      <td className={`num ${s.netCents < 0 ? "text-bad" : ""}`}>
                        <Money cents={s.netCents} currency={s.currency} />
                      </td>
                      <td className="whitespace-nowrap text-sm">
                        <PayoutCell state={s.payoutState} periodId={s.periodId} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager f={f} count={page.count} pages={pages} />
            <p className="mt-3 text-xs text-muted">Click a sale to see everything reported for it. Click a band, type, country or source to filter by it.</p>
          </>
        )}
      </Card>

      {main && (
        <>
          <h2 className="mt-10 mb-3 text-sm font-bold">
            Totals and breakdowns <span className="font-normal text-muted">({main.first} to {main.last}, following your filters)</span>
          </h2>
          <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Tile label="Net received" value={formatCents(main.net, main.currency)} />
            <Tile label={`Sale${main.sales === 1 ? "" : "s"}`} value={main.sales.toLocaleString("en-US")} hint={`${main.units.toLocaleString("en-US")} items`} />
            <Tile label="Average per sale" value={formatCents(Math.round(main.net / Math.max(1, main.sales)), main.currency)} />
            <Tile
              label="Refunds"
              value={main.refunds.toLocaleString("en-US")}
              hint={main.refunds ? formatCents(main.refundCents, main.currency) : undefined}
            />
          </div>
          {summary.totals.length > 1 && (
            <p className="-mt-3 mb-6 text-xs text-muted">
              Totals and charts are in {cur}. Also:{" "}
              {summary.totals
                .slice(1)
                .map((t) => `${formatCents(t.net, t.currency)} from ${t.sales} sale${t.sales === 1 ? "" : "s"}`)
                .join(", ")}{" "}
              (currencies aren’t converted).
            </p>
          )}

          <ChartBoard boardId="sales" charts={charts} defaults={defaults} saved={saved} />
        </>
      )}
    </>
  );
}

const PAYOUT_LABEL = { paid: "Paid out", pending: "In a payout, not paid yet" } as const;
const PAYOUT_TONE = { paid: "good", pending: "warn" } as const;

function PayoutBadge({ state }: { state: keyof typeof PAYOUT_LABEL }) {
  return <Badge tone={PAYOUT_TONE[state]}>{PAYOUT_LABEL[state]}</Badge>;
}

/**
 * Whether a sale is in a payout: a badge linking to it. Sales in no payout show nothing (their
 * money may never go out: some or all of it can be the label's, or the label account holder's).
 */
function PayoutCell({ state, periodId }: { state: "paid" | "pending" | "none"; periodId: number | null }) {
  if (state === "none" || !periodId) return <span className="text-muted">–</span>;
  return (
    <Link href={`/periods/${periodId}`} className="hover:no-underline" title="Open the payout">
      <PayoutBadge state={state} />
    </Link>
  );
}

function Filters({ f, options, filtered }: { f: SalesFilter; options: Awaited<ReturnType<typeof salesFilterOptions>>; filtered: boolean }) {
  const narrowed = !!(f.from || f.to || f.band || f.type || f.country !== undefined || f.source !== undefined || f.currency || f.refunds || f.payout);
  return (
    <form action="/sales" className="mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          name="q"
          type="search"
          defaultValue={f.q}
          placeholder="Search items, artists, transactions, or a buyer’s full email"
          aria-label="Search sales"
          className="min-w-0 flex-1"
        />
        <button type="submit" className={buttonClass("primary")}>
          Search
        </button>
        {filtered && (
          <Link href="/sales" className="text-sm">
            Clear
          </Link>
        )}
      </div>
      <details open={narrowed} className="mt-2">
        <summary className="cursor-pointer text-sm text-link">Filters{narrowed ? " (on)" : ""}</summary>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          <label>
            <span className="mb-1 block text-xs text-muted">From</span>
            <input name="from" type="date" defaultValue={f.from} />
          </label>
          <label>
            <span className="mb-1 block text-xs text-muted">To</span>
            <input name="to" type="date" defaultValue={f.to} />
          </label>
          <label>
            <span className="mb-1 block text-xs text-muted">Band</span>
            <select name="band" defaultValue={f.band ? String(f.band) : ""}>
              <option value="">All</option>
              {options.bands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
              {!f.onlyBands && <option value="none">Not matched to a band</option>}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-xs text-muted">Type</span>
            <select name="type" defaultValue={f.type ?? ""}>
              <option value="">All</option>
              {Object.entries(TYPE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-xs text-muted">Country</span>
            <select name="country" defaultValue={f.country ?? ""}>
              <option value="">All</option>
              {options.countries.map((c) => (
                <option key={c || "(none)"} value={c || "(none)"}>
                  {c || "Not given"}
                </option>
              ))}
            </select>
          </label>
          {options.sources.some(Boolean) && (
            <label>
              <span className="mb-1 block text-xs text-muted">Came from</span>
              <select name="source" defaultValue={f.source ?? ""}>
                <option value="">All</option>
                {options.sources.map((s) => (
                  <option key={s || "(direct)"} value={s || "(direct)"}>
                    {s || "Direct / unknown"}
                  </option>
                ))}
              </select>
            </label>
          )}
          {options.currencies.length > 1 && (
            <label>
              <span className="mb-1 block text-xs text-muted">Currency</span>
              <select name="currency" defaultValue={f.currency ?? ""}>
                <option value="">All</option>
                {options.currencies.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span className="mb-1 block text-xs text-muted">Paid out?</span>
            <select name="payout" defaultValue={f.payout ?? ""}>
              <option value="">All</option>
              <option value="paid">Paid out</option>
              <option value="pending">In a payout, not paid yet</option>
              <option value="none">Not in any payout</option>
            </select>
          </label>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input type="checkbox" name="refunds" value="1" defaultChecked={f.refunds} />
            Refunds only
          </label>
          <div className="flex items-end">
            <button type="submit" className={buttonClass("secondary")}>
              Apply
            </button>
          </div>
        </div>
      </details>
      {f.buyer && <input type="hidden" name="buyer" value={f.buyer} />}
      {f.sort !== "date" && <input type="hidden" name="sort" value={f.sort} />}
      {f.dir !== "desc" && <input type="hidden" name="dir" value={f.dir} />}
      {f.per !== DEFAULT_PAGE_SIZE && <input type="hidden" name="per" value={f.per} />}
    </form>
  );
}

/** "Showing 26–50 of 102", page links, and how many rows to show per page. */
function Pager({ f, count, pages }: { f: SalesFilter; count: number; pages: number }) {
  const first = (f.page - 1) * f.per + 1;
  const last = Math.min(count, f.page * f.per);
  // Page numbers: the first, the last, and two either side of this one.
  const shown = [...new Set([1, f.page - 2, f.page - 1, f.page, f.page + 1, f.page + 2, pages])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const href = (change: Partial<Record<keyof SalesFilter, number>>) => filterQuery(f, change) || "/sales";
  return (
    <nav className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-sm" aria-label="Pages">
      <span className="text-muted">
        Showing {first}–{last} of {count.toLocaleString("en-US")}
      </span>
      {pages > 1 && (
        <span className="flex flex-wrap items-center gap-1">
          {f.page > 1 && (
            <Link href={href({ page: f.page - 1 })} className="px-1.5">
              ← Previous
            </Link>
          )}
          {shown.map((n, i) => (
            <span key={n} className="flex items-center gap-1">
              {i > 0 && n - shown[i - 1] > 1 && <span className="text-muted">…</span>}
              {n === f.page ? (
                <span aria-current="page" className="rounded-sm bg-surface-2 px-2 py-0.5 font-bold">
                  {n}
                </span>
              ) : (
                <Link href={href({ page: n })} className="px-2 py-0.5">
                  {n}
                </Link>
              )}
            </span>
          ))}
          {f.page < pages && (
            <Link href={href({ page: f.page + 1 })} className="px-1.5">
              Next →
            </Link>
          )}
        </span>
      )}
      <span className="flex items-center gap-2 text-muted">
        Rows per page:
        {PAGE_SIZES.map((n) =>
          n === f.per ? (
            <span key={n} className="font-bold text-text">
              {n}
            </span>
          ) : (
            <Link key={n} href={href({ per: n, page: 1 })}>
              {n}
            </Link>
          ),
        )}
      </span>
    </nav>
  );
}

function SortHeader({ f, k, label, num = false }: { f: SalesFilter; k: SortKey; label: string; num?: boolean }) {
  const on = f.sort === k;
  // Text columns start A→Z; dates and numbers start biggest/newest first.
  const firstDir = ["item", "band", "type", "country", "source"].includes(k) ? "asc" : "desc";
  const dir = on ? (f.dir === "asc" ? "desc" : "asc") : firstDir;
  return (
    <th className={num ? "num" : ""} aria-sort={on ? (f.dir === "asc" ? "ascending" : "descending") : undefined}>
      <Link href={filterQuery(f, { sort: k, dir, page: 1 }) || "/sales"} className={`whitespace-nowrap hover:no-underline ${on ? "text-text" : "text-muted hover:text-text"}`}>
        {label}
        <span aria-hidden className="ml-1 inline-block w-2">
          {on ? (f.dir === "asc" ? "↑" : "↓") : ""}
        </span>
      </Link>
    </th>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border border-border bg-surface px-4 py-3">
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="text-xs text-muted">
        {label}
        {hint && <> · {hint}</>}
      </div>
    </div>
  );
}
