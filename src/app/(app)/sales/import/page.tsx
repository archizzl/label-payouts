import { asc, count, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { Fading, SubmitButton } from "@/components/client";
import { ImportForm } from "@/components/import-form";
import { Badge, Callout, Card, Empty, MoneyList, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { addBandFromArtist, assignArtistToBand, assignRouting, createReleaseFromSales, deleteImport } from "@/server/actions";
import { bandcampSubdomain } from "@/lib/applications";
import { bandScope, can } from "@/lib/permissions";
import { MANUAL_IMPORT } from "@/lib/manual-sales";
import { ManualSaleForm } from "@/components/manual-sale";
import { merchChoices, merchSources } from "@/server/manual-sales";
import { plural } from "@/lib/plural";
import { API_SYNC_PREFIX, bandcampCredentials } from "@/server/bandcamp-api";
import { SalesTabs } from "@/components/sales-tabs";
import { SyncFooter } from "@/components/sync-status";
import { requireAccess } from "@/server/context";
import { unroutedGroups } from "@/server/data";

export const metadata = { title: "import sales" };

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

type UnmatchedGroup = Awaited<ReturnType<typeof unroutedGroups>>[number];

/**
 * Unmatched sales by artist, biggest first, with the artist's own Bandcamp subdomain when all its
 * items are on one that no other artist (or the label itself) uses.
 */
function byArtist(groups: UnmatchedGroup[], labelSubdomain: string | null) {
  const subdomainOf = (url: string) => /^https?:\/\/([a-z0-9-]+)\.bandcamp\.com\//i.exec(url)?.[1]?.toLowerCase() ?? null;
  const artists = new Map<string, { artist: string; groups: UnmatchedGroup[]; count: number; totals: Map<string, number> }>();
  for (const g of groups) {
    const k = g.artist.trim().toLowerCase();
    const a = artists.get(k) ?? { artist: g.artist.trim(), groups: [], count: 0, totals: new Map<string, number>() };
    a.groups.push(g);
    a.count += g.count;
    for (const [cur, c] of g.totals) a.totals.set(cur, (a.totals.get(cur) ?? 0) + c);
    artists.set(k, a);
  }
  const usedBy = new Map<string, Set<string>>();
  for (const [k, a] of artists) for (const g of a.groups) {
    const sub = subdomainOf(g.itemUrl);
    if (sub) usedBy.set(sub, (usedBy.get(sub) ?? new Set()).add(k));
  }
  return [...artists.values()]
    .map((a) => {
      const subs = [...new Set(a.groups.map((g) => subdomainOf(g.itemUrl)))];
      const sub = subs.length === 1 && subs[0] && subs[0] !== labelSubdomain && usedBy.get(subs[0])!.size === 1 ? subs[0] : null;
      return { ...a, subdomain: sub, compilation: /\s\/\s|^various artists$/i.test(a.artist) || !a.artist };
    })
    .sort((x, y) => y.count - x.count);
}

export default async function ImportPage({ searchParams }: PageProps<"/sales/import">) {
  await connection();
  const ctx = await requireAccess("sales", "edit");
  const { orgId, isAdmin } = ctx;
  const canAddBands = can(ctx.access, "roster", "edit");
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
  const [settings] = await db.select({ url: schema.accountSettings.bandcampUrl }).from(schema.accountSettings).where(eq(schema.accountSettings.orgId, orgId));
  const labelSubdomain = settings?.url ? bandcampSubdomain(settings.url) : null;
  const catalog: Catalog = { bands, releases, tracks };
  const justImported = importedId ? allImports.find((i) => i.id === importedId) : null;
  // A sync that found nothing new only marks when we last checked; it's not worth a history row.
  // Hand-added sales hang off one import of their own: they're in the sales list, not here.
  const history = allImports.filter((h) => h.filename !== MANUAL_IMPORT && !(h.addedCount === 0 && h.filename.startsWith(API_SYNC_PREFIX)));
  const scope = bandScope(ctx.access, "sales");
  const [usual] = await db
    .select({ currency: schema.sales.currency })
    .from(schema.sales)
    .where(eq(schema.sales.orgId, orgId))
    .groupBy(schema.sales.currency)
    .orderBy(desc(count()))
    .limit(1);
  const bandCount = bands.length;
  const apiReady = !!creds;

  return (
    <>
      <PageHeader title="Sales" />
      <SalesTabs active="import" />
      {justImported && (
        <Fading clearParams={["imported"]}>
          <Callout tone="good">
            Imported {justImported.addedCount} new sales from {justImported.filename}
            {justImported.duplicateCount > 0 && ` (${justImported.duplicateCount} already imported, skipped)`}.
          </Callout>
        </Fading>
      )}
      {bandCount === 0 && <Callout>Tip: add your bands first so sales can be matched automatically. You can still import now and match later.</Callout>}

      {/* (A band account the label made: the label's sync brings in its sales through the label.) */}
      {!apiReady && !ctx.managedBy && (
        <Card>
          <p className="text-sm text-muted">
            {isAdmin ? (
              <>
                To pull sales automatically, add your Bandcamp API access (client ID and secret) under <Link href="/settings">Settings</Link>.
              </>
            ) : (
              "To pull sales automatically, an admin needs to add Bandcamp API access in Settings. Until then, upload the sales report here."
            )}
          </p>
        </Card>
      )}

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

      {bands.length > 0 && (
        <Card title="Add a sale by hand">
          <ManualSaleForm
            bands={scope ? bands.filter((b) => scope.includes(b.id)) : bands}
            merch={merchChoices(
              await merchSources({ orgId, managed: ctx.managedBy ? { labelOrgId: ctx.managedBy.labelOrgId, bandId: ctx.managedBy.bandId } : null, onlyBands: scope }),
            )}
            currency={usual?.currency ?? "USD"}
          />
        </Card>
      )}

      {noBand.length > 0 && (
        <Card title={<>Needs a band <Badge tone="warn">{plural(noBand.reduce((a, g) => a + g.count, 0), "sale")}</Badge></>}>
          {/* <p className="mb-4 text-sm text-muted">
            These sales didn’t match any band. Sort each artist out once and future imports match by themselves.
          </p> */}
          <ul className="space-y-3">
            {byArtist(noBand, labelSubdomain).map((a) => (
              <li key={a.artist || "?"} className="border border-border p-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-medium">{a.artist || "No artist given"}</span>
                  {a.subdomain && <span className="text-xs text-muted">{a.subdomain}.bandcamp.com</span>}
                  <span className="ml-auto text-sm">
                    {plural(a.groups.length, "item")} · {plural(a.count, "sale")} · <MoneyList totals={a.totals} />
                  </span>
                </div>
                {a.compilation && <p className="mt-1 text-sm text-muted">Looks like a split or compilation: pick a band for each item below.</p>}
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  {!a.compilation && a.artist && canAddBands && (
                    <form action={addBandFromArtist}>
                      <input type="hidden" name="artist" value={a.artist} />
                      <input type="hidden" name="subdomain" value={a.subdomain ?? ""} />
                      <SubmitButton size="sm">Add as a band</SubmitButton>
                    </form>
                  )}
                  {!a.compilation && bands.length > 0 && (
                    <form action={assignArtistToBand} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="artist" value={a.artist} />
                      {a.groups.map((g) => (
                        <input key={g.key} type="hidden" name="key" value={g.key} />
                      ))}
                      <select name="bandId" required defaultValue="" className="!w-56" aria-label={`Band for ${a.artist || "these sales"}`}>
                        <option value="" disabled>
                          {canAddBands && a.artist ? "or they’re on…" : "They’re on…"}
                        </option>
                        {bands.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      </select>
                      <SubmitButton size="sm" variant="secondary">
                        Assign all
                      </SubmitButton>
                    </form>
                  )}
                </div>
                <details className="mt-3" open={a.compilation}>
                  <summary className="text-sm text-link">{a.compilation ? "Items" : "Or one item at a time"}</summary>
                  <ul className="mt-3 space-y-3">
                    {a.groups.map((g) => (
                      <Group key={g.key} g={g} mode="no_band" catalog={catalog} />
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {noRelease.length > 0 && (
        <Card title={<>Matched to a band, but not a release <Badge>{noRelease.length} items</Badge></>}>
          {/* <p className="mb-3 text-sm text-muted">
            Optional. These use the band’s default or item-type split. Match them to a release or track if those have their own splits.
          </p> */}
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
      <SyncFooter orgId={orgId} />
    </>
  );
}
