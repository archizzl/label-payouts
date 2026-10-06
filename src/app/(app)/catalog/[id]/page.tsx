import { and, asc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { ActionForm, SubmitButton } from "@/components/client";
import { ItemCosts } from "@/components/item-cost";
import { SalesSection } from "@/components/sales-section";
import { costsFor } from "@/components/physical-formats";
import { SharesSummary, SplitRules, currentRule } from "@/components/split-rules";
import { Card, Disclosure, Empty, Field, MoneyList } from "@/components/ui";
import { db, schema } from "@/db";
import { addTracks, deleteRelease, deleteTrack, refreshReleaseFromBandcamp, saveRelease, saveTrack } from "@/server/actions";
import { requireAdmin } from "@/server/context";
import { bandAssociatedPeople, costDeductionsFor, nameMaps, personOptionsFor, ruleFilter, rulesWhere } from "@/server/data";

export default async function ReleasePage({ params, searchParams }: PageProps<"/catalog/[id]">) {
  await connection();
  const { orgId } = await requireAdmin();
  const id = Number((await params).id);
  const [release] = await db
    .select()
    .from(schema.releases)
    .where(and(eq(schema.releases.orgId, orgId), eq(schema.releases.id, id)));
  if (!release) notFound();
  const [[band], bands, tracks, people, bandPeople, costDeductions, names, bandRules, labelRules, outsideRows, peopleRows, releaseRules, sales] =
    await Promise.all([
      db.select().from(schema.bands).where(eq(schema.bands.id, release.bandId)),
      db.select().from(schema.bands).where(eq(schema.bands.orgId, orgId)).orderBy(asc(schema.bands.name)),
      db.select().from(schema.tracks).where(eq(schema.tracks.releaseId, id)).orderBy(asc(schema.tracks.position), asc(schema.tracks.id)),
      personOptionsFor(orgId, release.bandId),
      bandAssociatedPeople(orgId, release.bandId),
      costDeductionsFor(orgId, release.bandId),
      nameMaps(orgId),
      // What a track without its own split falls back to.
      rulesWhere(orgId, ruleFilter("band_default", { bandId: release.bandId })),
      rulesWhere(orgId, ruleFilter("label_default", {})),
      // Outside artists on this release (compilations) and who's paid for them.
      db.select().from(schema.outsideArtists).where(eq(schema.outsideArtists.orgId, orgId)),
      db.select().from(schema.people).where(eq(schema.people.orgId, orgId)),
      rulesWhere(orgId, ruleFilter("release", { releaseId: id })),
      db.select().from(schema.sales).where(eq(schema.sales.releaseId, id)),
    ]);
  const hasLabelDefault = labelRules.length > 0;
  const outside = new Map(outsideRows.map((a) => [a.id, a]));
  const contactPeople = new Map(peopleRows.map((p) => [p.id, p]));
  // Each track's split, and the people to choose from (a track can belong to another band).
  const trackRules = new Map(await Promise.all(tracks.map(async (t) => [t.id, await rulesWhere(orgId, ruleFilter("track", { trackId: t.id }))] as const)));
  const otherBandIds = [...new Set(tracks.map((t) => t.bandId ?? release.bandId).filter((b) => b !== release.bandId))];
  const peopleForBand = new Map(await Promise.all(otherBandIds.map(async (b) => [b, await personOptionsFor(orgId, b)] as const)));
  const outsideContact = (artistId: number) => {
    const personId = outside.get(artistId)?.contactPersonId;
    return personId ? (contactPeople.get(personId) ?? null) : null;
  };
  const trackFallback = currentRule(releaseRules)
    ? "release split"
    : bandRules.length
      ? "band default split"
      : band.isLabel
        ? "label keeps it"
        : hasLabelDefault
          ? "label-wide default split"
          : "no split set";
  const totals = new Map<string, number>();
  for (const s of sales) totals.set(s.currency, (totals.get(s.currency) ?? 0) + s.netCents);
  const totalSec = tracks.reduce((a, t) => a + (t.durationSec ?? 0), 0);
  const isMerch = release.kind === "merch";
  const item = isMerch ? release.packages[0] : undefined;
  const released = release.releaseDate
    ? new Date(`${release.releaseDate}T00:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })
    : null;

  return (
    <>
      {/* Bandcamp album-page layout: details on the left, artwork on the right. */}
      <div className="mb-10 flex flex-col-reverse gap-6 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <h1 className="text-[28px] leading-tight font-bold">{release.title}</h1>
          <p className="mt-1 text-lg">
            by <Link href={`/bands/${band.id}`}>{band.name}</Link>
          </p>
          <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            {released && (
              <>
                <dt className="text-muted">{isMerch ? "listed" : "released"}</dt>
                <dd>{released}</dd>
              </>
            )}
            {release.catalogNumber && (
              <>
                <dt className="text-muted">catalog #</dt>
                <dd>{release.catalogNumber}</dd>
              </>
            )}
            {release.upc && (
              <>
                <dt className="text-muted">UPC</dt>
                <dd className="tabular-nums">{release.upc}</dd>
              </>
            )}
            {isMerch ? (
              <>
                {item?.typeName && (
                  <>
                    <dt className="text-muted">type</dt>
                    <dd>{item.typeName}</dd>
                  </>
                )}
                {item?.sku && (
                  <>
                    <dt className="text-muted">SKU</dt>
                    <dd>{item.sku}</dd>
                  </>
                )}
                {item?.price != null && (
                  <>
                    <dt className="text-muted">price</dt>
                    <dd>
                      {item.price.toFixed(2)} {item.currency}
                    </dd>
                  </>
                )}
              </>
            ) : (
              <>
                <dt className="text-muted">tracks</dt>
                <dd>
                  {tracks.length}
                  {totalSec > 0 && ` · ${formatDuration(totalSec)}`}
                </dd>
              </>
            )}
            <dt className="text-muted">sales</dt>
            <dd>
              {sales.length ? (
                <>
                  {sales.length} · <MoneyList totals={totals} />
                </>
              ) : (
                <span className="text-muted">no sales yet</span>
              )}
            </dd>
          </dl>
          {release.tags.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {release.tags.map((t) => (
                <span key={t} className="bg-surface-2 px-2 py-0.5 text-xs text-muted">
                  {t}
                </span>
              ))}
            </div>
          )}
          <div className="mt-5 flex flex-wrap items-start gap-2">
            {release.url && (
              <a href={release.url} target="_blank" rel="noreferrer" className="self-center text-sm">
                view on Bandcamp ↗
              </a>
            )}
            {/* {release.url && (
              <ActionForm action={refreshReleaseFromBandcamp} className="text-sm">
                <input type="hidden" name="id" value={id} />
                <SubmitButton variant="secondary" size="sm">
                  refresh from Bandcamp
                </SubmitButton>
              </ActionForm>
            )} */}
          </div>
          {release.syncedAt && <p className="mt-2 text-xs text-muted">Last read from Bandcamp {release.syncedAt.slice(0, 10)}.</p>}
        </div>
        {release.artUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={release.artUrl} alt={`${release.title} cover`} className="aspect-square w-full bg-surface-2 object-cover sm:w-72" />
        )}
      </div>

      <SalesSection boardId="release-sales" scope={{ releaseId: id }} range={(await searchParams).range as string | undefined} basePath={`/catalog/${id}`} />

      <Card title={isMerch ? "Split" : "Release split"}>
        <p className="mb-3 text-sm text-muted">
          {isMerch
            ? "Applies to every sale of this item. Without one, the band’s merch split (or its default split) is used."
            : "Applies to album sales, merch tied to this release, and any track without its own split."}
        </p>
        <SplitRules
          rules={releaseRules}
          people={people}
          scope={{ scope: "release", releaseId: id }}
          emptyText={isMerch ? "No split for this item yet. Uses the band’s splits." : "No release split. Uses the band’s splits."}
        />
      </Card>

      {!isMerch && (
      <Card title="Tracks">
        {tracks.length === 0 ? (
          <Empty>No tracks. Add them to give individual songs their own splits (e.g. by songwriter).</Empty>
        ) : (
          // A compact Bandcamp-style tracklist; click a track to manage its split and details.
          <ul className="divide-y divide-border border-y border-border">
            {tracks.map((t) => {
              const trackBandId = t.bandId ?? release.bandId;
              const trackPeople = trackBandId === release.bandId ? people : (peopleForBand.get(trackBandId) ?? people);
              const rules = trackRules.get(t.id) ?? [];
              const cur = currentRule(rules);
              return (
                <li key={t.id}>
                  <details className="group">
                    <summary className="flex items-baseline gap-3 px-1 py-2 text-sm hover:bg-surface-2">
                      <span className="w-6 shrink-0 text-right text-muted tabular-nums">{t.position || ""}.</span>
                      <span className="min-w-0">
                        <span className="font-bold">{t.title}</span>
                        {t.durationSec ? <span className="ml-2 text-muted tabular-nums">{formatDuration(t.durationSec)}</span> : null}
                        {(t.artist || (t.bandId && t.bandId !== release.bandId)) && (
                          <span className="ml-2 text-xs text-muted">
                            by {t.bandId && t.bandId !== release.bandId ? bands.find((b) => b.id === t.bandId)?.name : t.artist}
                          </span>
                        )}
                      </span>
                      <span className="ml-auto shrink-0 text-right text-xs">
                        {cur ? (
                          <SharesSummary shares={cur.shares} people={trackPeople} />
                        ) : t.outsideArtistId ? (
                          outsideContact(t.outsideArtistId) ? (
                            <span className="text-muted">paid to {outsideContact(t.outsideArtistId)!.name}</span>
                          ) : outside.get(t.outsideArtistId)?.dismissed ? (
                            <span className="text-muted">not paid (label keeps it)</span>
                          ) : (
                            <Link href="/catalog#outside-artists" className="text-warn">
                              needs a contact
                            </Link>
                          )
                        ) : t.bandId && t.bandId !== release.bandId ? (
                          <span className="text-muted">{bands.find((b) => b.id === t.bandId)?.name}’s split</span>
                        ) : (
                          <span className="text-muted">{trackFallback}</span>
                        )}
                      </span>
                      <span className="shrink-0 text-xs text-link group-open:hidden">manage</span>
                      <span className="hidden shrink-0 text-xs text-link group-open:inline">close</span>
                    </summary>
                    <div className="mb-3 ml-9 space-y-5 border border-border bg-surface-2 p-4">
                      <div>
                        <h3 className="mb-2 text-sm font-bold">split</h3>
                        <SplitRules rules={rules} people={trackPeople} scope={{ scope: "track", trackId: t.id }} emptyText="No track split. Uses the release or band split." />
                      </div>
                      <div>
                        <h3 className="mb-2 text-sm font-bold">details</h3>
                        <form action={saveTrack} className="grid gap-3 sm:grid-cols-2">
                          <input type="hidden" name="id" value={t.id} />
                          <Field label="Title">
                            <input name="title" defaultValue={t.title} required />
                          </Field>
                          <Field label="Position">
                            <input name="position" type="number" defaultValue={t.position} />
                          </Field>
                          <Field label="Bandcamp URL">
                            <input name="url" defaultValue={t.url ?? ""} />
                          </Field>
                          <Field label="ISRC" hint="Sales with this ISRC are matched to this track.">
                            <input name="isrc" defaultValue={t.isrc ?? ""} />
                          </Field>
                          <Field label="Band" hint="Change this for split releases and compilations.">
                            <select name="bandId" defaultValue={t.bandId ?? ""}>
                              <option value="">Same as release ({band.name})</option>
                              {bands
                                .filter((b) => b.id !== release.bandId)
                                .map((b) => (
                                  <option key={b.id} value={b.id}>
                                    {b.name}
                                  </option>
                                ))}
                            </select>
                          </Field>
                          <div className="flex items-end gap-2">
                            <SubmitButton size="sm">save track</SubmitButton>
                          </div>
                        </form>
                        <form action={deleteTrack} className="mt-3">
                          <input type="hidden" name="id" value={t.id} />
                          <SubmitButton variant="danger" size="sm" confirm={`Delete ${t.title}?`}>
                            delete track
                          </SubmitButton>
                        </form>
                      </div>
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-4">
          <Disclosure summary="+ Add tracks">
            <form action={addTracks} className="space-y-3">
              <input type="hidden" name="releaseId" value={id} />
              <Field label="One track per line" hint="Optionally add the track URL after a pipe: “Undertow | https://glassharbor.bandcamp.com/track/undertow”">
                <textarea name="titles" rows={6} required />
              </Field>
              <SubmitButton>Add tracks</SubmitButton>
            </form>
          </Disclosure>
        </div>
      </Card>
      )}

      {isMerch && item?.options && item.options.length > 0 && (
        <Card title="Sizes & options">
          <table className="data">
            <thead>
              <tr>
                <th>option</th>
                <th>SKU</th>
              </tr>
            </thead>
            <tbody>
              {item.options.map((o) => (
                <tr key={o.title}>
                  <td>{o.title}</td>
                  <td>{o.sku ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted">Sales with any of these SKUs are matched to this item automatically.</p>
        </Card>
      )}

      {release.packages.length > 0 && !isMerch && (
        <Card title="Formats">
          <table className="data">
            <thead>
              <tr>
                <th>format</th>
                <th>type</th>
                <th>SKU</th>
                <th>UPC</th>
                <th className="num">price</th>
                <th>per-item cost</th>
              </tr>
            </thead>
            <tbody>
              {release.packages.map((p) => (
                <tr key={p.bandcampId}>
                  <td>{p.title}</td>
                  <td className="text-muted">{p.typeName}</td>
                  <td>{p.sku ?? "—"}</td>
                  <td className="tabular-nums">{p.upc ?? "—"}</td>
                  <td className="num">{p.price != null ? `${p.price.toFixed(2)} ${p.currency ?? ""}` : "—"}</td>
                  <td>
                    <ItemCosts
                      costs={costsFor(costDeductions, release, p)}
                      releaseId={release.id}
                      packageId={p.bandcampId}
                      currency={p.currency ?? "USD"}
                      people={bandPeople}
                      personName={names.person}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted">Merch sales with any of these SKUs or UPCs are matched to this release automatically.</p>
        </Card>
      )}

      {(release.about || release.credits) && (
        <Card title="About this release">
          {release.about && release.about.length <= 400 && <p className="mb-4 text-sm whitespace-pre-line">{release.about}</p>}
          {release.about && release.about.length > 400 && (
            <details className="group mb-4">
              <summary className="text-sm group-open:hidden">
                <span className="line-clamp-3 whitespace-pre-line">{release.about}</span>
                <span className="text-link">more…</span>
              </summary>
              <p className="text-sm whitespace-pre-line">{release.about}</p>
            </details>
          )}
          {release.credits && (
            <>
              <h3 className="mb-1 text-sm font-bold">credits</h3>
              <p className="text-sm whitespace-pre-line text-muted">{release.credits}</p>
            </>
          )}
        </Card>
      )}

      <Card title={isMerch ? "Item settings" : "Release settings"}>
        <form action={saveRelease} className="grid gap-4 sm:grid-cols-2">
          <input type="hidden" name="id" value={id} />
          {release.kind !== "album" && <input type="hidden" name="albumSplitMode" value={release.albumSplitMode} />}
          <Field label="Band">
            <select name="bandId" defaultValue={release.bandId}>
              {bands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Title" hint="Used to match sales by name when the URL doesn't match.">
            <input name="title" defaultValue={release.title} required />
          </Field>
          <Field label="Bandcamp URL" hint="Sales with exactly this item URL always route here.">
            <input name="url" defaultValue={release.url ?? ""} />
          </Field>
          <Field label="Catalog number">
            <input name="catalogNumber" defaultValue={release.catalogNumber ?? ""} />
          </Field>
          <Field label="Release date">
            <input name="releaseDate" type="date" defaultValue={release.releaseDate ?? ""} />
          </Field>
          {release.kind === "album" && (
            <Field label="Album sales without a release split use…" hint="Only matters when this release has no split of its own.">
              <select name="albumSplitMode" defaultValue={release.albumSplitMode}>
                <option value="band_default">the band’s split</option>
                <option value="average_tracks">the average of the track splits</option>
              </select>
            </Field>
          )}
          <div className="self-end">
            <SubmitButton>Save</SubmitButton>
          </div>
        </form>
        <form action={deleteRelease} className="mt-8 border-t border-border pt-4">
          <input type="hidden" name="id" value={id} />
          <SubmitButton variant="danger" size="sm" confirm={`Delete ${release.title}${isMerch ? "" : " and its tracks"} and splits?`}>
            {isMerch ? "Delete item" : "Delete release"}
          </SubmitButton>
        </form>
      </Card>
    </>
  );
}

function formatDuration(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
