import { and, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { BarList, MonthlyColumns } from "@/components/charts";
import { SalesTabs } from "@/components/sales-tabs";
import { Badge, buttonClass, Card, Empty, Money, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { formatCents } from "@/lib/money";
import { requireAdmin } from "@/server/context";
import {
  browseSales,
  filterQuery,
  PAGE_SIZE,
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
  const { orgId } = await requireAdmin();
  const f = parseSalesFilter(await searchParams);
  const [page, summary, options, [{ unrouted }]] = await Promise.all([
    browseSales(orgId, f),
    summarizeSales(orgId, f),
    salesFilterOptions(orgId),
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
    f.payout
  );
  const main = summary.totals[0];
  const pages = Math.max(1, Math.ceil(page.count / PAGE_SIZE));
  const cur = summary.main;

  return (
    <>
      <PageHeader
        title="Sales"
        subtitle="Every sale from Bandcamp. Filter, sort and dig in; the totals and charts follow your filters."
        actions={
          page.count > 0 && (
            <a href={`/sales/export${filterQuery(f, { page: 1 })}`} className={buttonClass("secondary")} download>
              Export CSV
            </a>
          )
        }
      />
      <SalesTabs active="browse" unrouted={unrouted} />

      <Filters f={f} options={options} filtered={filtered} />

      {!main ? (
        <Card>
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
        </Card>
      ) : (
        <>
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
          <p className="-mt-3 mb-6 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {(["paid", "pending", "none"] as const).map((st) =>
              summary.byPayout[st].sales ? (
                <Link key={st} href={filterQuery(f, { payout: f.payout === st ? undefined : st, page: 1 }) || "/sales"} className="text-text hover:no-underline">
                  <PayoutBadge state={st} /> <span className="tabular-nums">{formatCents(summary.byPayout[st].net, cur)}</span>{" "}
                  <span className="text-muted">
                    ({summary.byPayout[st].sales} sale{summary.byPayout[st].sales === 1 ? "" : "s"})
                  </span>
                </Link>
              ) : null,
            )}
          </p>
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

          <details className="group mb-6" open>
            <summary className="mb-3 cursor-pointer text-sm font-bold">
              Breakdowns <span className="font-normal text-muted">({main.first} to {main.last})</span>
            </summary>
            {summary.byMonth.length > 1 && (
              <Card title="Net received by month">
                <MonthlyColumns data={summary.byMonth} currency={cur} />
              </Card>
            )}
            <div className="grid gap-6 md:grid-cols-2">
              <Breakdown title="Top items" rows={summary.byItem} currency={cur} total={main.net} param={(k) => filterQuery(f, { q: k, page: 1 })} />
              {!f.band && <Breakdown title="By band" rows={summary.byBand} currency={cur} total={main.net} />}
              {!f.type && (
                <Breakdown
                  title="By type"
                  rows={summary.byType.map((r) => ({ ...r, key: TYPE_LABEL[r.key] ?? r.key }))}
                  currency={cur}
                  total={main.net}
                />
              )}
              {f.country === undefined && <Breakdown title="By country" rows={summary.byCountry} currency={cur} total={main.net} />}
              {f.source === undefined && summary.bySource.some((s) => s.key !== "Direct / unknown") && (
                <Breakdown title="Where fans came from" rows={summary.bySource} currency={cur} total={main.net} />
              )}
            </div>
          </details>

          <Card title={`${page.count.toLocaleString("en-US")} sale${page.count === 1 ? "" : "s"}`}>
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
            {pages > 1 && (
              <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pages">
                {f.page > 1 ? <Link href={filterQuery(f, { page: f.page - 1 }) || "/sales"}>← Newer</Link> : <span />}
                <span className="text-muted">
                  Page {f.page} of {pages}
                </span>
                {f.page < pages ? <Link href={filterQuery(f, { page: f.page + 1 })}>Older →</Link> : <span />}
              </nav>
            )}
            <p className="mt-3 text-xs text-muted">Click a sale to see everything Bandcamp reported for it. Click a band, type, country or source to filter by it.</p>
          </Card>
        </>
      )}
    </>
  );
}

const PAYOUT_LABEL = { paid: "Paid out", pending: "In a payout, not paid yet", none: "Not in a payout yet" } as const;
const PAYOUT_TONE = { paid: "good", pending: "warn", none: "neutral" } as const;

function PayoutBadge({ state }: { state: keyof typeof PAYOUT_LABEL }) {
  return <Badge tone={PAYOUT_TONE[state]}>{PAYOUT_LABEL[state]}</Badge>;
}

/** Whether a sale's money has gone out: a badge, linking to the payout that covers it. */
function PayoutCell({ state, periodId }: { state: keyof typeof PAYOUT_LABEL; periodId: number | null }) {
  const badge = <PayoutBadge state={state === "paid" ? "paid" : state === "pending" ? "pending" : "none"} />;
  return periodId ? (
    <Link href={`/periods/${periodId}`} className="hover:no-underline" title="Open the payout">
      {badge}
    </Link>
  ) : (
    badge
  );
}

function Filters({ f, options, filtered }: { f: SalesFilter; options: Awaited<ReturnType<typeof salesFilterOptions>>; filtered: boolean }) {
  return (
    <form action="/sales" className="mb-6 grid grid-cols-2 gap-3 border border-border bg-surface p-4 sm:grid-cols-4 lg:grid-cols-6">
      <label className="col-span-2">
        <span className="mb-1 block text-xs text-muted">Search</span>
        <input name="q" defaultValue={f.q} placeholder="Item, artist, format or transaction" />
      </label>
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
          <option value="none">Not matched to a band</option>
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
          <option value="none">Not in a payout yet</option>
        </select>
      </label>
      <label className="flex items-center gap-2 self-end pb-2 text-sm">
        <input type="checkbox" name="refunds" value="1" defaultChecked={f.refunds} />
        Refunds only
      </label>
      {f.sort !== "date" && <input type="hidden" name="sort" value={f.sort} />}
      {f.dir !== "desc" && <input type="hidden" name="dir" value={f.dir} />}
      <div className="col-span-2 flex items-end gap-3 sm:col-span-1">
        <button type="submit" className={buttonClass("primary")}>
          Filter
        </button>
        {filtered && (
          <Link href="/sales" className="pb-2 text-sm">
            Clear
          </Link>
        )}
      </div>
    </form>
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

function Breakdown({
  title,
  rows,
  currency,
  total,
  param,
}: {
  title: string;
  rows: { key: string; net: number; units: number }[];
  currency: string;
  total: number;
  param?: (key: string) => string;
}) {
  if (!rows.length) return null;
  return (
    <Card title={title}>
      <BarList data={rows} currency={currency} total={total} />
      {param && (
        <p className="mt-2 text-xs text-muted">
          See the sales for{" "}
          {rows.slice(0, 3).map((r, i) => (
            <span key={r.key}>
              {i > 0 && ", "}
              <Link href={param(r.key)}>{r.key}</Link>
            </span>
          ))}
          .
        </p>
      )}
    </Card>
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
