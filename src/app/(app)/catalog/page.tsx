import { asc, count, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { SubmitButton } from "@/components/client";
import { PhysicalFormatsTable } from "@/components/physical-formats";
import { OutsideArtists } from "@/components/outside-artists";
import { ReleaseImport } from "@/components/release-import";
import { Card, Disclosure, Empty, Field, PageHeader } from "@/components/ui";
import { db, schema } from "@/db";
import { saveRelease } from "@/server/actions";
import { requireAdmin } from "@/server/context";

export default async function CatalogPage({ searchParams }: PageProps<"/catalog">) {
  await connection();
  const bandFilter = Number((await searchParams).band) || null;
  const { orgId } = await requireAdmin();
  const [bands, releases, trackCountRows, rules] = await Promise.all([
    db.select().from(schema.bands).where(eq(schema.bands.orgId, orgId)).orderBy(asc(schema.bands.name)),
    db
      .select()
      .from(schema.releases)
      .where(eq(schema.releases.orgId, orgId))
      .orderBy(desc(schema.releases.releaseDate), asc(schema.releases.title)),
    db
      .select({ releaseId: schema.tracks.releaseId, n: count() })
      .from(schema.tracks)
      .where(eq(schema.tracks.orgId, orgId))
      .groupBy(schema.tracks.releaseId),
    db.select().from(schema.splitRules).where(eq(schema.splitRules.orgId, orgId)),
  ]);
  const trackCounts = new Map(trackCountRows.map((r) => [r.releaseId, r.n]));
  const splitReleases = new Set(rules.map((r) => r.releaseId));
  /** The split a release without its own uses: the band's merch split, its default, or the label-wide default. */
  const fallbackSplit = (bandId: number, merch: boolean) =>
    merch && rules.some((r) => r.scope === "band_item_type" && r.bandId === bandId && r.itemCategory === "merch")
      ? "band merch split"
      : rules.some((r) => r.scope === "band_default" && r.bandId === bandId)
        ? "band default split"
        : bands.find((b) => b.id === bandId)?.isLabel
          ? "label keeps it"
          : rules.some((r) => r.scope === "label_default")
          ? "label-wide default split"
          : "no split set";
  const shown = bands.filter((b) => !bandFilter || b.id === bandFilter);

  return (
    <>
      <PageHeader title="Catalog" subtitle="Releases, tracks and merch. Give any of them its own split, or let them use the band’s splits." />
      <ReleaseImport />
      <OutsideArtists />
      <div className="mb-4 flex flex-wrap gap-2 text-sm">
        <Link href="/catalog" className={`rounded-full px-3 py-1 ${!bandFilter ? "bg-text text-bg" : "bg-surface-2 text-muted"}`}>
          all bands
        </Link>
        {bands.map((b) => (
          <Link key={b.id} href={`/catalog?band=${b.id}`} className={`rounded-full px-3 py-1 ${bandFilter === b.id ? "bg-text text-bg" : "bg-surface-2 text-muted"}`}>
            {b.name}
          </Link>
        ))}
      </div>
      {bands.length === 0 && (
        <Card>
          <Empty>
            Add a <Link href="/bands" className="underline">band</Link> first.
          </Empty>
        </Card>
      )}
      {shown.map((b) => {
        const rs = releases.filter((r) => r.bandId === b.id);
        const music = rs.filter((r) => r.kind !== "merch");
        const merch = rs.filter((r) => r.kind === "merch");
        const grid = (items: typeof rs) => (
          <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-4 md:grid-cols-5">
            {items.map((r) => (
              <li key={r.id}>
                <Link href={`/catalog/${r.id}`} className="group block text-text hover:no-underline">
                  {r.artUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.artUrl.replace(/_(10|16)\.jpg$/, "_2.jpg")} alt="" loading="lazy" className="aspect-square w-full bg-surface-2 object-cover" />
                  ) : (
                    <div className="flex aspect-square w-full items-center justify-center bg-surface-2 text-xs text-muted">no artwork</div>
                  )}
                  <div className="mt-1.5 text-sm leading-snug font-bold group-hover:underline">{r.title}</div>
                </Link>
                <div className="text-xs text-muted">
                  {(r.kind === "merch"
                    ? [r.packages[0]?.typeName, r.packages[0]?.sku, r.packages[0]?.options?.length ? `${r.packages[0].options.length} options` : null]
                    : [r.catalogNumber, r.releaseDate?.slice(0, 4), r.kind === "track" ? "single" : null, `${trackCounts.get(r.id) ?? 0} tracks`]
                  )
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                <div className="text-xs text-muted">
                  {splitReleases.has(r.id)
                    ? "custom split"
                    : r.kind !== "merch" && r.albumSplitMode === "average_tracks"
                      ? "average of tracks"
                      : fallbackSplit(r.bandId, r.kind === "merch")}
                </div>
              </li>
            ))}
          </ul>
        );
        return (
          <Card key={b.id} title={<Link href={`/bands/${b.id}`} className="hover:underline">{b.name}</Link>}>
            {rs.length === 0 ? (
              <p className="text-sm text-muted">No releases or merch.</p>
            ) : (
              // Only the sections a band actually has.
              <div className="space-y-8">
                {music.length > 0 && (
                  <div>
                    <h3 className="mb-3 text-sm font-bold">releases</h3>
                    {grid(music)}
                  </div>
                )}
                {music.some((r) => r.packages.length > 0) && (
                  <div>
                    <h3 className="mb-3 text-sm font-bold">physical formats</h3>
                    <PhysicalFormatsTable releases={music} />
                  </div>
                )}
                {merch.length > 0 && (
                  <div>
                    <h3 className="mb-3 text-sm font-bold">standalone merch</h3>
                    {grid(merch)}
                  </div>
                )}
              </div>
            )}
          </Card>
        );
      })}
      {bands.length > 0 && (
        <Disclosure summary="+ Add release">
          <form action={saveRelease} className="grid gap-4 sm:grid-cols-2">
            <input type="hidden" name="open" value="true" />
            <Field label="Band">
              <select name="bandId" defaultValue={bandFilter ?? bands[0].id}>
                {bands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Title">
              <input name="title" required />
            </Field>
            <Field label="Bandcamp URL">
              <input name="url" placeholder="https://….bandcamp.com/album/…" />
            </Field>
            <Field label="Catalog number">
              <input name="catalogNumber" />
            </Field>
            <div className="sm:col-span-2">
              <SubmitButton>Add release</SubmitButton>
            </div>
          </form>
        </Disclosure>
      )}
    </>
  );
}
