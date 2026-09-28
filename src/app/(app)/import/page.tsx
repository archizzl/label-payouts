import { asc, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { ActionForm, SubmitButton } from "@/components/client";
import { ImportForm } from "@/components/import-form";
import { Badge, Callout, Card, Empty, MoneyList, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { assignRouting, createReleaseFromSales, deleteImport, syncBandcampSales } from "@/server/actions";
import { API_SYNC_PREFIX, bandcampCredentials } from "@/server/bandcamp-api";
import { requireAdmin } from "@/server/context";
import { unroutedGroups } from "@/server/data";

/** The account's bands, releases and tracks, for choosing where unmatched sales belong. */
type Catalog = {
  bands: (typeof schema.bands.$inferSelect)[];
  releases: (typeof schema.releases.$inferSelect)[];
  tracks: (typeof schema.tracks.$inferSelect)[];
};

function TargetSelect({ bandId, catalog: { bands, releases, tracks } }: { bandId?: number | null; catalog: Catalog }) {
  return (
    <select name="target" required defaultValue="" className="!w-72 max-w-full" aria-label="Where these sales belong">
      <option value="" disabled>
        Belongs to…
      </option>
      {bands
        .filter((b) => !bandId || b.id === bandId)
        .map((b) => (
          <optgroup key={b.id} label={b.name}>
            {!bandId && <option value={`b:${b.id}`}>{b.name} (no specific release)</option>}
            {releases
              .filter((r) => r.bandId === b.id)
              .flatMap((r) => [
                <option key={`r${r.id}`} value={`r:${r.id}`}>
                  {r.title}
                </option>,
                ...tracks
                  .filter((t) => t.releaseId === r.id)
                  .map((t) => (
                    <option key={`t${t.id}`} value={`t:${t.id}`}>
                      {"   "}
                      {t.title}
                    </option>
                  )),
              ])}
          </optgroup>
        ))}
    </select>
  );
}

function Group({ g, mode, catalog }: { g: Awaited<ReturnType<typeof unroutedGroups>>[number]; mode: "no_band" | "no_release"; catalog: Catalog }) {
  const { bands } = catalog;
  return (
    <li className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-medium">{g.itemName || "(no item name)"}</span>
        <span className="text-sm text-muted">{g.artist || "no artist"}</span>
        <Badge>{g.category}</Badge>
        <span className="ml-auto text-sm">
          {g.count} sale{g.count === 1 ? "" : "s"} · <MoneyList totals={g.totals} />
        </span>
      </div>
      {g.itemUrl && <div className="mt-1 font-mono text-xs break-all text-muted">{g.itemUrl}</div>}
      <div className="mt-3 flex flex-wrap gap-3">
        <form action={assignRouting} className="flex flex-wrap gap-2">
          <input type="hidden" name="key" value={g.key} />
          <TargetSelect bandId={mode === "no_release" ? g.bandId : null} catalog={catalog} />
          <SubmitButton size="sm">Assign &amp; remember</SubmitButton>
        </form>
        {bands.length > 0 && (g.category === "album" || g.category === "track" || mode === "no_release") && (
          <form action={createReleaseFromSales} className="flex flex-wrap gap-2">
            <input type="hidden" name="key" value={g.key} />
            {mode === "no_release" && g.bandId ? (
              <input type="hidden" name="bandId" value={g.bandId} />
            ) : (
              <select name="bandId" required defaultValue="" className="!w-48" aria-label="Band for new release">
                <option value="" disabled>
                  Band…
                </option>
                {bands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            )}
            <SubmitButton size="sm" variant="secondary">
              Create {g.category === "track" ? "track" : "release"} from this
            </SubmitButton>
          </form>
        )}
      </div>
    </li>
  );
}

export default async function ImportPage({ searchParams }: PageProps<"/import">) {
  await connection();
  const { orgId } = await requireAdmin();
  const importedId = Number((await searchParams).imported) || null;
  const [allImports, noBand, noRelease, bands, releases, tracks, creds] = await Promise.all([
    db.select().from(schema.imports).where(eq(schema.imports.orgId, orgId)).orderBy(desc(schema.imports.importedAt)),
    unroutedGroups(orgId, "no_band"),
    unroutedGroups(orgId, "no_release"),
    db.select().from(schema.bands).where(eq(schema.bands.orgId, orgId)).orderBy(asc(schema.bands.name)),
    db.select().from(schema.releases).where(eq(schema.releases.orgId, orgId)).orderBy(asc(schema.releases.title)),
    db.select().from(schema.tracks).where(eq(schema.tracks.orgId, orgId)).orderBy(asc(schema.tracks.position)),
    bandcampCredentials(orgId),
  ]);
  const catalog: Catalog = { bands, releases, tracks };
  const justImported = importedId ? allImports.find((i) => i.id === importedId) : null;
  // A sync that found nothing new only marks when we last checked; it's not worth a history row.
  const history = allImports.filter((h) => !(h.addedCount === 0 && h.filename.startsWith(API_SYNC_PREFIX)));
  const bandCount = bands.length;
  const apiReady = !!creds;
  const lastSync = allImports.find((h) => h.filename.startsWith(API_SYNC_PREFIX));

  return (
    <>
      <PageHeader title="Import sales" subtitle="Pull the label-wide sales report from Bandcamp, or upload it as a CSV. Overlapping reports are safe: sales already imported are skipped." />
      {justImported && (
        <Callout tone="good">
          Imported {justImported.addedCount} new sales from {justImported.filename}
          {justImported.duplicateCount > 0 && ` (${justImported.duplicateCount} already imported, skipped)`}.
        </Callout>
      )}
      {bandCount === 0 && <Callout>Tip: add your bands first so sales can be matched automatically. You can still import now and match later.</Callout>}

      <Card title="Sync from Bandcamp">
        {apiReady ? (
          <ActionForm action={syncBandcampSales} className="space-y-3">
            <p className="text-sm text-muted">
              Fetches the raw sales report for your label and all its artists through the Bandcamp API and imports every sale that
              isn’t here yet, including refunds.
              {lastSync ? <> Last synced {lastSync.importedAt.replace("T", " ").slice(0, 16)}.</> : " Not synced yet."}
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <SubmitButton>Sync sales now</SubmitButton>
              <details className="text-sm">
                <summary className="text-muted">only from a date…</summary>
                <label className="mt-2 flex items-center gap-2">
                  From <input type="date" name="from" className="!w-44" />
                </label>
              </details>
            </div>
          </ActionForm>
        ) : (
          <p className="text-sm text-muted">
            To pull sales automatically, add your Bandcamp API access (client ID and secret) under{" "}
            <Link href="/account">Settings</Link>.
          </p>
        )}
      </Card>

      <Card title={apiReady ? "Or upload a CSV" : "Upload"}>
        <ImportForm />
        <details className="mt-4 text-sm text-muted">
          <summary className="font-medium">Where do I get this file?</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>Log into Bandcamp as the label account.</li>
            <li>Open <b>Tools</b> (the label’s Tools page, where the sales reports are).</li>
            <li>Under <b>Sales Report</b>, pick a date range and choose <b>All artists</b>.</li>
            <li>Download as CSV and drop it above. UTF-8 and UTF-16 files both work.</li>
          </ol>
        </details>
      </Card>

      {history.length > 0 && (
        <Card title={<>Needs a band {noBand.length > 0 && <Badge tone="warn">{noBand.reduce((a, g) => a + g.count, 0)} sales</Badge>}</>}>
          {noBand.length === 0 ? (
            <Empty>Every sale is matched to a band.</Empty>
          ) : (
            <>
              <p className="mb-3 text-sm text-muted">
                These sales couldn’t be matched to a band. Assign each item once and the app remembers it for future imports.
                Adding the artist name or URL to a band’s settings also works.
              </p>
              <ul className="space-y-3">
                {noBand.map((g) => (
                  <Group key={g.key} g={g} mode="no_band" catalog={catalog} />
                ))}
              </ul>
            </>
          )}
        </Card>
      )}

      {noRelease.length > 0 && (
        <Card title={<>Matched to a band, but not a release <Badge>{noRelease.length} items</Badge></>}>
          <p className="mb-3 text-sm text-muted">
            Optional. These use the band’s default or item-type split. Match them to a release or track if those have their own splits.
          </p>
          <details>
            <summary className="text-sm font-medium text-accent">Show items</summary>
            <ul className="mt-3 space-y-3">
              {noRelease.map((g) => (
                <Group key={g.key} g={g} mode="no_release" catalog={catalog} />
              ))}
            </ul>
          </details>
        </Card>
      )}

      {history.length > 0 && (
        <Card title="Import history">
          {history.length === 0 ? (
            <Empty>No imports yet.</Empty>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Imported</th>
                  <th className="num">Added</th>
                  <th className="num">Duplicates</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td>{h.filename}</td>
                    <td className="text-muted">{h.importedAt.replace("T", " ").slice(0, 16)}</td>
                    <td className="num">{h.addedCount}</td>
                    <td className="num">{h.duplicateCount}</td>
                    <td className="text-right">
                      <form action={deleteImport}>
                        <input type="hidden" name="id" value={h.id} />
                        <SubmitButton variant="ghost" size="sm" confirm={`Remove the ${h.addedCount} sales from this import? Finalized payouts are not affected.`}>
                          Undo import
                        </SubmitButton>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </>
  );
}
