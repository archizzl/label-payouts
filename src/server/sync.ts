import "server-only";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { ParseResult } from "@/lib/bandcamp-csv";
import { parseBandcampApiReport } from "@/lib/bandcamp-csv";
import {
  type LabelArtist,
  type LabelRelease,
  labelArtistsUrl,
  labelMerchUrl,
  labelMusicUrl,
  parseBandPhoto,
  parseLabelArtists,
  parseLabelMerch,
  parseLabelMusic,
  parseLabelName,
} from "@/lib/bandcamp-label";
import { parseReleasePage } from "@/lib/bandcamp-release";
import { normalizeText, routeSale, routingKey } from "@/lib/routing";
import { allBands, BLOCKED_MESSAGE, createBandFor, fetchPage, findBandFor, findExistingRelease, hostOf, isBotChallenge, rememberLabelPhoto, upsertRelease } from "./bandcamp";
import { API_SYNC_PREFIX, bandcampCredentials, salesReport } from "./bandcamp-api";
import { emailFingerprint } from "./secrets";
import { loadCatalog, reRouteAll } from "./data";

/*
 * Bringing things in from Bandcamp: sales (through the API), and artists, releases and merch (from
 * the account's public Bandcamp pages). Everything takes the account explicitly, so it can run from
 * an admin's button (after its permission check) or from the background sync (src/server/auto-sync.ts).
 */

const { bands, releases, tracks, imports, sales, outsideArtists } = schema;

// ---------- sales ----------

export async function prepare(orgId: string, parsed: ParseResult) {
  const catalog = await loadCatalog(orgId);
  const keys = parsed.sales.map((s) => s.dedupeKey);
  const existing = new Set<string>();
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    const found = await db
      .select({ k: sales.dedupeKey })
      .from(sales)
      .where(and(eq(sales.orgId, orgId), inArray(sales.dedupeKey, chunk)));
    for (const r of found) existing.add(r.k);
  }
  const routed = parsed.sales.map((s) => ({ sale: s, route: routeSale(s, catalog), duplicate: existing.has(s.dedupeKey) }));
  return { parsed, routed, catalog };
}

/** Store the new (not yet imported) sales of a parsed report as one import. */
/** The buyer's fingerprint: "" when the report has no email, null when it can't be made (no key set up). */
function buyerKeyOf(email: string): string | null {
  if (!email) return "";
  try {
    return emailFingerprint(email) ?? "";
  } catch {
    return null;
  }
}

export async function saveSales(orgId: string, filename: string, parsed: ParseResult) {
  const { routed } = await prepare(orgId, parsed);
  const fresh = routed.filter((r) => !r.duplicate);
  const importId = await db.transaction(async (tx) => {
    const [{ id }] = await tx
      .insert(imports)
      .values({ orgId, filename, rowCount: routed.length, addedCount: fresh.length, duplicateCount: routed.length - fresh.length })
      .returning({ id: imports.id });
    for (let i = 0; i < fresh.length; i += 500) {
      await tx
        .insert(sales)
        .values(
          fresh.slice(i, i + 500).map(({ sale: s, route }) => ({
            orgId,
            importId: id,
            dedupeKey: s.dedupeKey,
            date: s.date,
            itemType: s.itemType,
            category: s.category,
            itemName: s.itemName,
            artist: s.artist,
            itemUrl: s.itemUrl,
            packageName: s.packageName,
            currency: s.currency,
            netCents: s.netCents,
            quantity: s.quantity,
            transactionId: s.transactionId,
            routingKey: routingKey(s),
            bandId: route.bandId,
            releaseId: route.releaseId,
            trackId: route.trackId,
            routedVia: route.via,
            raw: s.raw,
            buyerKey: buyerKeyOf(s.buyerEmail),
          })),
        )
        .onConflictDoNothing();
    }
    // Sales imported before buyers were fingerprinted get theirs from this report.
    const known = routed.filter((r) => r.duplicate && r.sale.buyerEmail && buyerKeyOf(r.sale.buyerEmail));
    for (let i = 0; i < known.length; i += 500) {
      const rows = known.slice(i, i + 500).map((r) => sql`(${r.sale.dedupeKey}, ${buyerKeyOf(r.sale.buyerEmail)})`);
      await tx.execute(sql`
        update ${sales} set buyer_key = v.key
        from (values ${sql.join(rows, sql`, `)}) as v(dedupe_key, key)
        where ${sales.orgId} = ${orgId} and ${sales.dedupeKey} = v.dedupe_key and ${sales.buyerKey} is null`);
    }
    return id;
  });
  return { importId, added: fresh.length, duplicates: routed.length - fresh.length };
}

/**
 * Pull the account's raw sales report straight from the Bandcamp API and import what's new. The
 * whole history is fetched each time (late refunds included); anything already imported, whether
 * by an earlier sync or a CSV upload, is skipped. Throws if Bandcamp can't be reached.
 */
export async function runSalesSync(orgId: string, from = "2000-01-01") {
  const creds = await bandcampCredentials(orgId);
  if (!creds) throw new Error("This account has no Bandcamp API access set up. Add it under Settings.");
  const report = await salesReport(orgId, creds, new Date(`${from}T00:00:00Z`), new Date(Date.now() + 86_400_000));
  const parsed = parseBandcampApiReport(report.rows);
  if (parsed.missingColumns.length) throw new Error(`Bandcamp's report was missing ${parsed.missingColumns.join(", ")}.`);
  const names = report.accounts.map((a) => a.name).join(", ");
  const dates = parsed.sales.map((s) => s.date).sort();
  const range = dates.length ? ` · ${dates[0]} – ${dates[dates.length - 1]}` : "";
  const { importId, added, duplicates } = await saveSales(orgId, `${API_SYNC_PREFIX} · ${names}${range}`, parsed);
  // Keep only the latest sync that found nothing new: it records when we last checked.
  const empty = await db
    .select()
    .from(imports)
    .where(and(eq(imports.orgId, orgId), eq(imports.addedCount, 0), ne(imports.id, importId)));
  const staleIds = empty.filter((i) => i.filename.startsWith(API_SYNC_PREFIX)).map((i) => i.id);
  if (staleIds.length) await db.delete(imports).where(inArray(imports.id, staleIds));
  return { importId, added, duplicates, names };
}

// ---------- grab bands from a Bandcamp label page ----------

export type LabelArtistRow = LabelArtist & {
  /** new: not in the app yet · linked: already a band · add_url: band exists by name but lacks this URL */
  status: "new" | "linked" | "add_url";
  bandId: number | null;
};

export type LabelLookup = { label: string | null; source: string; artists: LabelArtistRow[] } | { error: string; blocked?: true };

/** The label's artists page: each artist, and whether it's already a band here. Also fills in band photos and locations. */
export async function lookupLabelArtists(orgId: string, input: string): Promise<LabelLookup> {
  const url = labelArtistsUrl(input);
  if (!url) return { error: "Enter your label's Bandcamp address, e.g. mylabel.bandcamp.com" };
  let html: string;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (labelmaker; reading my own label's artist list)" },
      signal: AbortSignal.timeout(20000),
      redirect: "follow",
    });
    if (res.status === 404) {
      return {
        error: `There’s no artists page at ${url}. That usually means it’s a single artist’s account rather than a label. Use your label’s own Bandcamp address.`,
      };
    }
    html = await res.text();
    if (isBotChallenge(html)) return { error: BLOCKED_MESSAGE, blocked: true };
    if (!res.ok) return { error: `Bandcamp answered ${res.status} for ${url}. Check the address, or try again in a minute.` };
  } catch (e) {
    return { error: `Couldn't reach ${url} (${(e as Error).message}). Are you online?` };
  }
  const artists = parseLabelArtists(html);
  await rememberLabelPhoto(orgId, html);
  if (artists.length === 0) {
    return {
      error: `No artists found at ${url}. Make sure this is a label account (label pages have an “artists” tab), not a single artist's page.`,
    };
  }
  const existing = await allBands(orgId);
  // Keep linked bands' photos current (an artist who changes theirs leaves the old link dead), and
  // fill in missing locations.
  for (const a of artists) {
    const b = existing.find((x) => x.urlPatterns.some((p) => p.toLowerCase() === a.urlPattern));
    if (b && ((a.imageUrl && a.imageUrl !== b.imageUrl) || (!b.location && a.location))) {
      await db
        .update(bands)
        .set({ imageUrl: a.imageUrl ?? b.imageUrl, location: b.location ?? a.location })
        .where(eq(bands.id, b.id));
    }
  }
  return {
    label: parseLabelName(html),
    source: url,
    artists: artists.map((a) => {
      const byUrl = existing.find((b) => b.urlPatterns.some((p) => p.toLowerCase() === a.urlPattern));
      if (byUrl) return { ...a, status: "linked", bandId: byUrl.id };
      const n = normalizeText(a.name);
      const byName = existing.find((b) => [b.name, ...b.aliases].some((x) => normalizeText(x) === n));
      if (byName) return { ...a, status: "add_url", bandId: byName.id };
      return { ...a, status: "new", bandId: null };
    }),
  };
}

/** Create the given bands (or add the Bandcamp URL to ones that already exist by name). */
export async function addArtists(orgId: string, rows: LabelArtistRow[]): Promise<{ added: number; updated: number }> {
  let added = 0;
  let updated = 0;
  await db.transaction(async (tx) => {
    for (const r of rows) {
      const current = await tx.select().from(bands).where(eq(bands.orgId, orgId));
      if (r.status === "new") {
        if (current.some((b) => b.urlPatterns.includes(r.urlPattern))) continue;
        await tx.insert(bands).values({ orgId, name: r.name, urlPatterns: [r.urlPattern], location: r.location, imageUrl: r.imageUrl });
        added++;
      } else if (r.status === "add_url" && r.bandId) {
        const b = current.find((x) => x.id === r.bandId);
        if (b && !b.urlPatterns.includes(r.urlPattern)) {
          await tx
            .update(bands)
            .set({
              urlPatterns: [...b.urlPatterns, r.urlPattern],
              location: b.location ?? r.location,
              imageUrl: b.imageUrl ?? r.imageUrl,
            })
            .where(eq(bands.id, b.id));
          updated++;
        }
      }
    }
  });
  if (added || updated) await reRouteAll(orgId);
  return { added, updated };
}

/**
 * Photos for bands with their own Bandcamp page (e.g. artists that came from the API and aren't on
 * the label's artists page): fetched when missing, or when the saved one no longer loads. Returns
 * how many changed.
 */
export async function refreshBandPhotos(orgId: string): Promise<number> {
  let updated = 0;
  for (const b of await allBands(orgId)) {
    const subdomain = b.urlPatterns.find((p) => /^[a-z0-9-]+$/i.test(p));
    if (!subdomain) continue;
    if (b.imageUrl) {
      const still = await fetch(b.imageUrl, { method: "HEAD", signal: AbortSignal.timeout(10000) }).then((r) => r.status !== 404, () => true);
      if (still) continue;
    }
    const page = await fetchPage(`https://${subdomain.toLowerCase()}.bandcamp.com/`);
    if ("error" in page) continue;
    const photo = parseBandPhoto(page.html);
    if (photo && photo !== b.imageUrl) {
      await db.update(bands).set({ imageUrl: photo }).where(eq(bands.id, b.id));
      updated++;
    }
  }
  return updated;
}

// ---------- grab releases from a Bandcamp label page ----------

export type LabelReleaseRow = LabelRelease & {
  /** Credited to the label itself (a label tape, a compilation): filed under the label's own band. */
  labelRelease: boolean;
  bandId: number | null;
  /** The band it will be filed under: an existing band, or the artist name for a band that will be created. */
  bandName: string;
  releaseId: number | null;
  status: "new" | "imported";
};

export type ReleaseLookup =
  | { label: string | null; source: string; labelHost: string; releases: LabelReleaseRow[] }
  | { error: string; blocked?: true };

/** Every release and merch item on the label's page, and which band it belongs to (or would be created for). */
export async function lookupLabelReleases(orgId: string, input: string): Promise<ReleaseLookup> {
  const url = labelMusicUrl(input);
  const merchUrl = labelMerchUrl(input);
  if (!url || !merchUrl) return { error: "Enter your label's Bandcamp address, e.g. mylabel.bandcamp.com" };
  const [page, merchPage] = await Promise.all([fetchPage(url), fetchPage(merchUrl)]);
  if ("error" in page) {
    if (page.blocked) return { error: page.error, blocked: true };
    return {
      error:
        page.status === 404
          ? `There’s no music page at ${url}. Check the address.`
          : `${page.error}. Check the address, or try again in a minute.`,
    };
  }
  const labelName = parseLabelName(page.html);
  await rememberLabelPhoto(orgId, page.html);
  const found = parseLabelMusic(page.html, url);
  // Standalone merch. With only one item, Bandcamp redirects /merch straight to that item's page;
  // with none (or only formats of releases) it redirects to an album, which has nothing to add.
  if (!("error" in merchPage)) {
    if (/\/merch\/[^/]+/.test(merchPage.finalUrl)) {
      const d = parseReleasePage(merchPage.html, merchPage.finalUrl);
      if (d) found.push({ bandcampId: d.bandcampId, kind: "merch", title: d.title, artist: d.artist, url: d.url, artUrl: d.artUrl });
    } else {
      found.push(...parseLabelMerch(merchPage.html, merchUrl));
    }
  }
  if (found.length === 0) return { error: `No releases or merch found at ${url}.` };
  // Items on the label's own page with no artist credit are the label's own (logo shirts, compilations).
  for (const r of found) if (!r.artist && hostOf(r.url) === hostOf(url)) r.artist = labelName;
  const labelHost = hostOf(url);
  const bandRows = await allBands(orgId);
  const rows: LabelReleaseRow[] = [];
  for (const r of found) {
    const band = findBandFor(r.url, r.artist, labelHost, bandRows);
    const existing = await findExistingRelease(orgId, r, band?.id ?? null);
    const bandId = existing?.bandId ?? band?.id ?? null;
    rows.push({
      ...r,
      labelRelease: !!labelName && !!r.artist && normalizeText(r.artist) === normalizeText(labelName),
      bandId,
      bandName: (bandId && bandRows.find((b) => b.id === bandId)?.name) || "",
      releaseId: existing?.id ?? null,
      status: existing ? "imported" : "new",
    });
  }

  // Artists that aren't bands yet: releases on the same Bandcamp page belong together
  // ("Amen Dunes" and "Amen Dunes feat. Westerman"), named after the most common artist credit.
  // Releases hosted on the label's own page are grouped by artist name.
  const groupKey = (r: LabelRelease) => {
    const host = hostOf(r.url);
    return host && host !== labelHost ? `host:${host}` : `artist:${normalizeText(r.artist ?? "")}`;
  };
  const credits = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (r.bandId) continue;
    const m = credits.get(groupKey(r)) ?? new Map<string, number>();
    const name = r.artist ?? "Unknown artist";
    m.set(name, (m.get(name) ?? 0) + 1);
    credits.set(groupKey(r), m);
  }
  const nameFor = (key: string) =>
    [...(credits.get(key) ?? new Map())].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] ?? "Unknown artist";
  for (const r of rows) if (!r.bandId) r.bandName = nameFor(groupKey(r));

  return { label: labelName, source: url, labelHost, releases: rows };
}

export type ReleaseImportResult =
  | { ok: true; title: string; tracks: number; createdBand: string | null; created: boolean; compilation: boolean }
  | { ok: false; title: string; error: string };

export type ReleaseImportRow = {
  url: string;
  title: string;
  artist: string | null;
  /** Name to give the band if it has to be created. */
  bandName: string;
  bandId: number | null;
  releaseId: number | null;
};

/** How many release pages the server fetches at once. Kept low to be polite to Bandcamp. */
const FETCH_CONCURRENCY = 3;

/** Fetch release pages and save them (several at a time, politely). Call reRouteAll afterwards. */
export async function importReleases(
  orgId: string,
  rows: ReleaseImportRow[],
  labelHost: string,
  labelName: string | null = null,
): Promise<ReleaseImportResult[]> {
  const results: ReleaseImportResult[] = new Array(rows.length);
  // Pages are fetched in parallel, but saved one at a time, so two releases by a new artist can't
  // both create the band.
  let saving = Promise.resolve();
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const i = next++;
      try {
        const page = await fetchPage(rows[i].url);
        const save = saving.then(() => importOne(orgId, rows[i], page, labelHost, labelName));
        saving = save.then(
          () => {},
          () => {},
        );
        results[i] = await save;
      } catch (e) {
        results[i] = { ok: false, title: rows[i].title, error: (e as Error).message };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, rows.length) }, worker));
  return results;
}

async function importOne(
  orgId: string,
  row: ReleaseImportRow,
  page: Awaited<ReturnType<typeof fetchPage>>,
  labelHost: string,
  labelName: string | null,
): Promise<ReleaseImportResult> {
  if ("error" in page) return { ok: false, title: row.title, error: page.error };
  const details = parseReleasePage(page.html, row.url);
  if (!details) return { ok: false, title: row.title, error: "No release data on the page (private or removed?)" };

  let createdBand: string | null = null;
  const bandRows = await allBands(orgId);
  let bandId = row.bandId && bandRows.some((b) => b.id === row.bandId) ? row.bandId : null;
  if (!bandId) {
    const artist = row.bandName || details.artist || row.artist || "Unknown artist";
    const isLabel = !!labelName && normalizeText(artist) === normalizeText(labelName);
    const found = findBandFor(details.url, artist, labelHost, bandRows);
    const band = found ?? (await createBandFor(orgId, details.url, artist, labelHost, isLabel));
    if (found && isLabel && !found.isLabel) await db.update(bands).set({ isLabel: true }).where(eq(bands.id, found.id));
    // The label's own band doesn't need members, so it isn't reported as a new band to set up.
    if (!found && !isLabel) createdBand = band.name;
    bandId = band.id;
  }
  // Pages on the label's own account show the label's profile photo.
  if (hostOf(details.url) === labelHost) await rememberLabelPhoto(orgId, page.html);
  const existing = row.releaseId ?? (await findExistingRelease(orgId, details, bandId))?.id ?? null;
  if (existing) {
    const [mine] = await db
      .select({ id: releases.id })
      .from(releases)
      .where(and(eq(releases.orgId, orgId), eq(releases.id, existing)));
    if (!mine) throw new Error("That release isn't part of this account.");
  }
  const res = await upsertRelease(orgId, details, bandId, existing);
  return { ok: true, title: details.title, tracks: res.tracks, createdBand, created: res.created, compilation: res.compilation };
}

export async function outsideArtistsNeedingContact(orgId: string) {
  const [trackRows, artists] = await Promise.all([
    db.select({ outsideArtistId: tracks.outsideArtistId }).from(tracks).where(eq(tracks.orgId, orgId)),
    db.select().from(outsideArtists).where(eq(outsideArtists.orgId, orgId)),
  ]);
  const used = new Set(trackRows.map((t) => t.outsideArtistId));
  return artists.filter((a) => used.has(a.id) && !a.contactPersonId && !a.dismissed).length;
}

