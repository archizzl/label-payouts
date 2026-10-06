import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { MonthlyColumns } from "@/components/charts";
import { SubmitButton } from "@/components/client";
import { FanImportForm } from "@/components/fan-import-form";
import { buttonClass, Card, Empty, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { requireAdmin } from "@/server/context";
import { deleteFans } from "@/server/fan-actions";
import { type FanFilter, fanStats, listFans } from "@/server/fans";

/** The mailing list, from Bandcamp's mailing-list export. Admins only: it's fans' personal data. */
export default async function FansPage({ searchParams }: PageProps<"/fans">) {
  await connection();
  const ctx = await requireAdmin();
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
          <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Tile label="On the list" value={stats.total.toLocaleString("en-US")} />
            <Tile label="Signed up in the last 30 days" value={stats.last30.toLocaleString("en-US")} />
            <Tile label="Countries" value={String(stats.byCountry.filter((c) => c.country).length)} />
          </div>

          {stats.byMonth.length > 1 && (
            <Card title="Sign-ups by month">
              <MonthlyColumns data={stats.byMonth.map((m) => ({ month: m.month, net: m.n, units: m.n }))} unit="count" label="Fan sign-ups by month" />
            </Card>
          )}

          <div className="grid gap-6 md:grid-cols-2">
            {!isBand && (
              <Card title="By band">
                <table className="data">
                  <tbody>
                    {stats.byBand
                      .map((b) => ({ ...b, name: bandName.get(b.bandId) ?? `#${b.bandId}` }))
                      .sort((a, b) => b.n - a.n)
                      .map((b) => (
                        <tr key={b.bandId}>
                          <td>
                            <Link href={`/fans?band=${b.bandId}`} className="hover:underline">
                              {b.name}
                            </Link>
                          </td>
                          <td className="num">{b.n.toLocaleString("en-US")}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                {stats.byBand.length === 0 && <p className="text-sm text-muted">Everyone is on the label’s own list.</p>}
              </Card>
            )}
            <Card title="Top countries">
              <table className="data">
                <tbody>
                  {stats.byCountry.slice(0, 10).map((c) => (
                    <tr key={c.country}>
                      <td className={c.country ? "" : "text-muted"}>{c.country || "Not given"}</td>
                      <td className="num">{c.n.toLocaleString("en-US")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>

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

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border bg-surface px-4 py-3">
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}
