import "server-only";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { parseBandPhoto } from "@/lib/bandcamp-label";
import type { ReleaseDetails } from "@/lib/bandcamp-release";
import { matchesBandPattern, normalizeText, normalizeUrl } from "@/lib/routing";

const { bands, releases, tracks, outsideArtists } = schema;

const UA = "Mozilla/5.0 (label-payouts; reading my own label's public pages)";

/** GET a public Bandcamp page. Waits and retries once if Bandcamp says we're going too fast. */
export async function fetchPage(url: string): Promise<{ html: string; finalUrl: string } | { status: number; error: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000), redirect: "follow" });
    } catch (e) {
      return { status: 0, error: `Couldn't reach ${url} (${(e as Error).message})` };
    }
    if (res.status === 429 || res.status === 503) {
      const wait = Number(res.headers.get("retry-after")) * 1000 || 4000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, Math.min(wait, 20000)));
      continue;
    }
    if (!res.ok) return { status: res.status, error: `Bandcamp answered ${res.status} for ${url}` };
    return { html: await res.text(), finalUrl: res.url || url };
  }
  return { status: 429, error: "Bandcamp is rate-limiting requests. Wait a minute and try again." };
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

function subdomainPattern(host: string): string {
  const m = host.match(/^([a-z0-9-]+)\.bandcamp\.com$/);
  return m ? m[1] : host;
}

type BandRow = typeof bands.$inferSelect;

/**
 * Which band a release belongs to: by its Bandcamp subdomain (unless it's hosted on the label's own
 * page), then by artist name or alias.
 */
export function findBandFor(url: string, artist: string | null, labelHost: string, all: BandRow[]) {
  const host = hostOf(url);
  if (host && host !== labelHost) {
    const n = normalizeUrl(url);
    const byUrl = all.find((b) => b.urlPatterns.some((p) => matchesBandPattern(n, p)));
    if (byUrl) return byUrl;
  }
  if (artist) {
    const a = normalizeText(artist);
    return all.find((b) => [b.name, ...b.aliases].some((x) => normalizeText(x) === a)) ?? null;
  }
  return null;
}

/** Every band in the account, for matching releases to bands. */
export function allBands(orgId: string) {
  return db.select().from(bands).where(eq(bands.orgId, orgId));
}

/** Give the label's own band its Bandcamp profile photo, read from any page of the label's account. */
export async function rememberLabelPhoto(orgId: string, html: string) {
  const photo = parseBandPhoto(html);
  if (!photo) return;
  await db
    .update(bands)
    .set({ imageUrl: photo })
    .where(and(eq(bands.orgId, orgId), eq(bands.isLabel, true), or(isNull(bands.imageUrl), ne(bands.imageUrl, photo))));
}

/** Create a band for a release's artist. Never records the label's own subdomain as a band URL. */
export async function createBandFor(orgId: string, url: string, artist: string, labelHost: string, isLabel = false): Promise<BandRow> {
  const host = hostOf(url);
  const [band] = await db
    .insert(bands)
    .values({ orgId, name: artist, isLabel, urlPatterns: host && host !== labelHost ? [subdomainPattern(host)] : [] })
    .returning();
  return band;
}

/** Find (or create) the outside artist with this name. Names compare loosely ("The X" = "x"). */
async function outsideArtistId(orgId: string, name: string): Promise<number> {
  const n = normalizeText(name);
  const existing = (await db.select().from(outsideArtists).where(eq(outsideArtists.orgId, orgId))).find((a) => normalizeText(a.name) === n);
  if (existing) return existing.id;
  const [created] = await db.insert(outsideArtists).values({ orgId, name: name.trim() }).returning({ id: outsideArtists.id });
  return created.id;
}

export async function findExistingRelease(
  orgId: string,
  r: { bandcampId: number; url: string; title: string; kind: "album" | "track" | "merch" },
  bandId: number | null,
) {
  const all = await db.select().from(releases).where(eq(releases.orgId, orgId));
  const url = normalizeUrl(r.url);
  // Album, track and merch ids are separate number spaces on Bandcamp.
  const sameKind = (x: (typeof all)[number]) => (x.kind === "merch") === (r.kind === "merch");
  return (
    all.find((x) => x.bandcampId === r.bandcampId && sameKind(x)) ??
    all.find((x) => x.url && normalizeUrl(x.url) === url) ??
    // By title only for entries you added by hand: different Bandcamp items can share a title
    // (e.g. several pressings or shirts called the same thing).
    (bandId
      ? all.find((x) => x.bandcampId === null && x.bandId === bandId && sameKind(x) && normalizeText(x.title) === normalizeText(r.title))
      : undefined) ??
    null
  );
}

/**
 * Create or update a release and its tracks from Bandcamp. Your own edits are kept where they
 * matter: the release's band, a catalog number you typed, splits, and tracks you added by hand.
 *
 * Compilations: a track credited to another band on the label is attributed to that band; a track
 * credited to anyone else is attributed to an outside artist (paid via their contact). A release
 * seen as a compilation for the first time splits its album sales across its tracks.
 */
export async function upsertRelease(orgId: string, d: ReleaseDetails, bandId: number, existingId: number | null) {
  const allBands = await db.select().from(bands).where(eq(bands.orgId, orgId));
  // Track credits that are really the label itself, or the release's own band, aren't outside artists.
  const labelNames = allBands.filter((b) => b.isLabel).flatMap((b) => [b.name, ...b.aliases].map(normalizeText));
  const outsideIds = new Map<string, number>();
  for (const t of d.tracks) {
    if (!t.artist) continue;
    const n = normalizeText(t.artist);
    const onLabel = allBands.some((b) => [b.name, ...b.aliases].some((x) => normalizeText(x) === n));
    if (!onLabel && !labelNames.includes(n)) outsideIds.set(n, await outsideArtistId(orgId, t.artist));
  }
  return db.transaction(async (tx) => {
    const [existing] = existingId
      ? await tx
          .select()
          .from(releases)
          .where(and(eq(releases.orgId, orgId), eq(releases.id, existingId)))
      : [];
    const fields = {
      title: d.title,
      url: d.url,
      bandcampId: d.bandcampId || null,
      kind: d.kind,
      upc: d.upc,
      artUrl: d.artUrl,
      about: d.about,
      credits: d.credits,
      tags: d.tags,
      packages: d.packages,
      syncedAt: new Date().toISOString(),
      ...(d.releaseDate ? { releaseDate: d.releaseDate } : {}),
    };
    let releaseId: number;
    if (existing) {
      releaseId = existing.id;
      // Keep a catalog number you typed; replace one that was only ever a Bandcamp SKU.
      const skus = [...existing.packages, ...d.packages].map((p) => p.sku?.toUpperCase());
      const keepCatalog = existing.catalogNumber && !skus.includes(existing.catalogNumber.toUpperCase());
      await tx
        .update(releases)
        .set({ ...fields, catalogNumber: keepCatalog ? existing.catalogNumber : d.catalogNumber || existing.catalogNumber })
        .where(eq(releases.id, releaseId));
    } else {
      const [created] = await tx
        .insert(releases)
        .values({ ...fields, orgId, bandId, catalogNumber: d.catalogNumber })
        .returning({ id: releases.id });
      releaseId = created.id;
    }
    const releaseBandId = existing?.bandId ?? bandId;

    const current = await tx.select().from(tracks).where(eq(tracks.releaseId, releaseId));
    const wasAttributed = current.some((c) => c.outsideArtistId !== null || (c.bandId !== null && c.bandId !== releaseBandId));
    const used = new Set<number>();
    let added = 0;
    for (const t of d.tracks) {
      const match =
        current.find((c) => !used.has(c.id) && t.bandcampId && c.bandcampId === t.bandcampId) ??
        current.find((c) => !used.has(c.id) && t.url && c.url && normalizeUrl(c.url) === normalizeUrl(t.url)) ??
        current.find((c) => !used.has(c.id) && normalizeText(c.title) === normalizeText(t.title));
      // A track credited to another band on the label (split releases, compilations).
      const creditedBand = t.artist
        ? allBands.find((b) => b.id !== releaseBandId && [b.name, ...b.aliases].some((x) => normalizeText(x) === normalizeText(t.artist!)))
        : undefined;
      const outsideId = t.artist ? (outsideIds.get(normalizeText(t.artist)) ?? null) : null;
      const values = {
        title: t.title,
        url: t.url,
        position: t.position,
        durationSec: t.durationSec,
        bandcampId: t.bandcampId,
        artist: t.artist,
      };
      if (match) {
        used.add(match.id);
        // A band you picked for the track by hand wins over what the credit says.
        const bandIdForTrack = match.bandId ?? creditedBand?.id ?? null;
        await tx
          .update(tracks)
          .set({
            ...values,
            isrc: match.isrc || t.isrc,
            bandId: bandIdForTrack,
            outsideArtistId: bandIdForTrack ? null : outsideId,
          })
          .where(eq(tracks.id, match.id));
      } else {
        await tx
          .insert(tracks)
          .values({ ...values, orgId, releaseId, isrc: t.isrc, bandId: creditedBand?.id ?? null, outsideArtistId: creditedBand ? null : outsideId });
        added++;
      }
    }

    const isCompilation = d.tracks.some((t) => {
      if (!t.artist) return false;
      const n = normalizeText(t.artist);
      return outsideIds.has(n) || allBands.some((b) => b.id !== releaseBandId && [b.name, ...b.aliases].some((x) => normalizeText(x) === n));
    });
    // Album sales of a compilation are shared across its tracks' artists, the first time we see it
    // as one (after that it's your setting to change).
    if (isCompilation && d.kind === "album" && (!existing || (!wasAttributed && existing.albumSplitMode === "band_default"))) {
      await tx.update(releases).set({ albumSplitMode: "average_tracks" }).where(eq(releases.id, releaseId));
    }
    return { releaseId, tracks: d.tracks.length, addedTracks: added, created: !existing, compilation: isCompilation };
  });
}
