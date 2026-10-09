import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { ChartBoard } from "@/components/chart-board";
import { SubmitButton } from "@/components/client";
import { FanImportForm } from "@/components/fan-import-form";
import { buttonClass, Card, Empty, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { type BoardChart, breakdownChart, buildTrend, seriesChart } from "@/lib/chart-data";
import type { ChartFormat } from "@/lib/chart-layout";
import { formatCents } from "@/lib/money";
import { loadLayout } from "@/server/chart-layouts";
import { requireAccess } from "@/server/context";
import { deleteFans } from "@/server/fan-actions";
import { type FanFilter, fanStats, listFans, type Purchase } from "@/server/fans";

/** The mailing list, from Bandcamp's mailing-list export. Admins only: it's fans' personal data. */
export default async function FansPage({ searchParams }: PageProps<"/fans">) {
  await connection();
  const ctx = await requireAccess("fans");
  const { orgId } = ctx;
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const bandParam = typeof sp.band === "string" ? sp.band : "";
  const filter: FanFilter = { q: q || undefined, bandId: bandParam === "label" ? "label" : Number(bandParam) || null };

  const [bands, stats, list] = await Promise.all([
    db.select({ id: schema.bands.id, name: schema.bands.name }).from(schema.bands).where(eq(schema.bands.orgId, orgId)).orderBy(asc(schema.bands.name)),
    fanStats(orgId),
    listFans(orgId, filter),
  ]);
  const bandName = new Map(bands.map((b) => [b.id, b.name]));
  const isBand = ctx.org.kind === "band";

  // The customizable charts.
  const bandRows = stats.byBand.map((b) => ({ key: bandName.get(b.bandId) ?? `#${b.bandId}`, net: b.n, bandId: b.bandId })).sort((a, b) => b.net - a.net);
  const countryRows = stats.byCountry.map((c) => ({ key: c.country || "Not given", net: c.n }));
  const charts: BoardChart[] = [
    seriesChart("month", "Sign-ups by month", stats.byMonth.map((m) => ({ month: m.month, value: m.n })), { currency: "USD", unit: "count" }),
    ...(isBand
      ? []
      : [
          breakdownChart("band", "By band", bandRows, {
            currency: "USD",
            unit: "count",
            total: stats.total,
            share: "of the list",
            showUnits: false,
            trend: buildTrend(stats.bandMonths.map((r) => ({ month: r.month, key: bandName.get(r.bandId) ?? `#${r.bandId}`, value: r.n }))),
            links: bandRows.slice(0, 3).map((b) => ({ label: b.key, href: `/fans?band=${b.bandId}` })),
            linksLabel: "See the fans on the list for",
          }),
        ]),
    breakdownChart("country", "Top countries", countryRows, {
      currency: "USD",
      unit: "count",
      total: stats.total,
      share: "of the list",
      showUnits: false,
      trend: buildTrend(stats.countryMonths.map((r) => ({ month: r.month, key: r.country, value: r.n }))),
    }),
  ];
  const defaults: [string, ChartFormat?][] = [
    ...(stats.byMonth.length > 1 ? [["month"] as [string]] : []),
    ...(isBand ? [] : [["band", "table"] as [string, ChartFormat]]),
    ["country", "table"],
  ];
  const saved = await loadLayout("fans");
  const ownList = isBand ? "band’s own list" : "label’s own list";
  const exportQuery = new URLSearchParams({ ...(q && { q }), ...(bandParam && { band: bandParam }) }).toString();

  return (
    <>
      <PageHeader
        title="Fans"
        subtitle="Your Bandcamp mailing list, kept here so you can see it grow and take it anywhere. Only admins can see it."
        actions={
          stats.total > 0 && (
            <a href={`/fans/export${exportQuery ? `?${exportQuery}` : ""}`} className={buttonClass("secondary")} download>
              Export CSV
            </a>
          )
        }
      />

      <Card title="Import from Bandcamp">
        <p className="mb-4 text-sm text-muted">
          On Bandcamp, open <strong className="text-text">Tools</strong> and, under <strong className="text-text">Mailing list</strong>, export the
          full list (or just the addresses added since your last export). Drop the file here. Importing the same people again is safe: they’re
          matched by email.
        </p>
        <FanImportForm bands={bands} isBandAccount={isBand} />
      </Card>

      {stats.total === 0 ? (
        <Card>
          <Empty>No fans yet. Import your Bandcamp mailing list above.</Empty>
        </Card>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Tile label="On the list" value={stats.total.toLocaleString("en-US")} />
            <Tile label="Signed up in the last 30 days" value={stats.last30.toLocaleString("en-US")} />
            <Tile label="Countries" value={String(stats.byCountry.filter((c) => c.country).length)} />
            <Tile
              label={stats.buyers.known ? `of ${stats.buyers.known.toLocaleString("en-US")} buyers are on the list` : "Buyers on the list"}
              value={stats.buyers.known ? stats.buyers.onList.toLocaleString("en-US") : "–"}
            />
          </div>
          {stats.buyers.known === 0 && (
            <p className="-mt-3 mb-6 text-sm text-muted">
              Purchases show up here once sales are synced from Bandcamp again (or a sales report CSV is imported): fans are matched to what
              they bought by email.
            </p>
          )}

          {stats.top.length > 0 && (
            <Card title="Biggest supporters on the list">
              <table className="data">
                <tbody>
                  {stats.top.map((t) => (
                    <tr key={`${t.fanId}-${t.currency}`}>
                      <td>
                        {t.name ?? t.email}
                        {t.name && <div className="text-xs text-muted">{t.email}</div>}
                      </td>
                      <td className="num text-muted">
                        {t.items} item{t.items === 1 ? "" : "s"}
                      </td>
                      <td className="num font-medium">{formatCents(t.cents, t.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted">What reached you from their purchases (Bandcamp’s net amount).</p>
            </Card>
          )}

          <ChartBoard boardId="fans" charts={charts} defaults={defaults} saved={saved} />

          <Card title="Everyone on the list">
            <form className="mb-4 flex flex-wrap items-end gap-3" action="/fans">
              <label className="min-w-0 flex-1">
                <span className="mb-1 block text-xs text-muted">Search</span>
                <input name="q" defaultValue={q} placeholder="Email, name or country" />
              </label>
              {!isBand && (
                <label>
                  <span className="mb-1 block text-xs text-muted">List</span>
                  <select name="band" defaultValue={bandParam} className="!w-auto">
                    <option value="">Everyone</option>
                    <option value="label">The label’s own list</option>
                    {bands.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button className={buttonClass("secondary")} type="submit">
                Search
              </button>
              {(q || bandParam) && (
                <Link href="/fans" className="text-sm">
                  Clear
                </Link>
              )}
            </form>
            {list.rows.length === 0 ? (
              <Empty>No one matches.</Empty>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Email</th>
                        <th>Name</th>
                        <th>Country</th>
                        <th>Signed up</th>
                        {!isBand && <th>Lists</th>}
                        <th>Bought</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {list.rows.map((f) => (
                        <tr key={f.id}>
                          <td className="break-all">{f.email}</td>
                          <td>{f.name ?? <span className="text-muted">–</span>}</td>
                          <td>
                            {f.country ?? <span className="text-muted">–</span>}
                            {f.postalCode && <span className="text-xs text-muted"> {f.postalCode}</span>}
                          </td>
                          <td className="whitespace-nowrap text-muted">{f.addedOn}</td>
                          {!isBand && (
                            <td className="text-sm">
                              {f.bandIds.length ? f.bandIds.map((b) => bandName.get(b)).join(", ") : <span className="text-muted">{ownList}</span>}
                            </td>
                          )}
                          <td className="text-sm">
                            <Bought purchases={f.purchases} bandName={bandName} />
                          </td>
                          <td className="text-right">
                            <form action={deleteFans}>
                              <input type="hidden" name="id" value={f.id} />
                              <SubmitButton variant="ghost" size="sm" confirm={`Remove ${f.email} from the list? This deletes everything stored about them.`}>
                                Remove
                              </SubmitButton>
                            </form>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {list.count > list.rows.length && (
                  <p className="mt-3 text-sm text-muted">
                    Showing the {list.rows.length} newest of {list.count.toLocaleString("en-US")}. Search to narrow it down, or export them all.
                  </p>
                )}
              </>
            )}
            <p className="mt-4 text-xs text-muted">
              If someone asks to be taken off the list, remove them here too, and on Bandcamp (or they’ll come back with the next import).
            </p>
          </Card>

          {stats.imports.length > 0 && (
            <Card title="Imports">
              <ul className="space-y-1 text-sm">
                {stats.imports.map((i) => (
                  <li key={i.id} className="flex flex-wrap gap-x-2">
                    <span>{i.filename}</span>
                    <span className="text-muted">
                      · {i.createdAt.slice(0, 10)} · {i.rowCount} in file, {i.addedCount} new
                      {i.bandId ? ` · ${bandName.get(i.bandId) ?? ""}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </>
  );
}

/** "3 · $24.00", opening to the items they bought. */
function Bought({ purchases, bandName }: { purchases: Purchase[]; bandName: Map<number, string> }) {
  if (!purchases.length) return <span className="text-muted">–</span>;
  const totals = new Map<string, number>();
  for (const p of purchases) totals.set(p.currency, (totals.get(p.currency) ?? 0) + p.netCents);
  return (
    <details>
      <summary className="cursor-pointer whitespace-nowrap">
        {purchases.length} · {[...totals].map(([c, v]) => formatCents(v, c)).join(" + ")}
      </summary>
      <ul className="mt-1 space-y-0.5 text-xs text-muted">
        {purchases.slice(0, 20).map((p, i) => (
          <li key={i}>
            {p.date} · {p.itemName}
            {p.bandId ? ` (${bandName.get(p.bandId) ?? p.artist})` : p.artist ? ` (${p.artist})` : ""} · {formatCents(p.netCents, p.currency)}
          </li>
        ))}
        {purchases.length > 20 && <li>…and {purchases.length - 20} more</li>}
      </ul>
    </details>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border bg-surface px-4 py-3">
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}
