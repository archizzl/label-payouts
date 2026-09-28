import type { ItemCategory } from "./bandcamp-csv";

export type BandInfo = { id: number; name: string; aliases: string[]; urlPatterns: string[] };
/** identifiers: catalog number, UPC, and each physical format's SKU and UPC. */
export type ReleaseInfo = { id: number; bandId: number; title: string; url: string | null; identifiers?: string[] };
/** bandId is the effective band: the track's own override, else its release's band. */
export type TrackInfo = { id: number; releaseId: number; bandId: number; title: string; url: string | null; isrc?: string | null };
export type RoutingOverride = {
  matchKey: string;
  bandId: number;
  releaseId: number | null;
  trackId: number | null;
};

export type Catalog = {
  bands: BandInfo[];
  releases: ReleaseInfo[];
  tracks: TrackInfo[];
  overrides: RoutingOverride[];
};

export type RoutableSale = {
  itemUrl: string;
  artist: string;
  itemName: string;
  packageName?: string;
  category: ItemCategory;
  catalogNumber?: string;
  upc?: string;
  isrc?: string;
};

export type RouteVia = "override" | "item_url" | "identifier" | "band_url" | "artist";

export type RouteResult = {
  bandId: number | null;
  releaseId: number | null;
  trackId: number | null;
  via: RouteVia | null;
};

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "");
}

/** Catalog numbers, UPCs and ISRCs compare case- and punctuation-insensitively. */
export function normalizeId(s: string | null | undefined): string {
  return (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function normalizeUrl(u: string): string {
  return u
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

/** The key a manual routing decision is remembered under. */
export function routingKey(sale: Pick<RoutableSale, "itemUrl" | "artist" | "itemName">): string {
  if (sale.itemUrl) return `url:${normalizeUrl(sale.itemUrl)}`;
  return `name:${normalizeText(sale.artist)}|${normalizeText(sale.itemName)}`;
}

function hostOf(normUrl: string): string {
  return normUrl.split("/")[0];
}

export function matchesBandPattern(normUrl: string, pattern: string): boolean {
  const p = normalizeUrl(pattern);
  if (!p) return false;
  const host = hostOf(normUrl);
  if (!p.includes(".") && !p.includes("/")) return host === `${p}.bandcamp.com`;
  if (!p.includes("/")) return host === p;
  return normUrl === p || normUrl.startsWith(`${p}/`);
}

/** Fuzzy title match: exact normalized match wins, else the longest title contained in the item name. */
function bestTitleMatch<T extends { title: string }>(candidates: T[], ...names: string[]): T | null {
  const normNames = names.map(normalizeText).filter(Boolean);
  for (const n of normNames) {
    const exact = candidates.find((c) => normalizeText(c.title) === n);
    if (exact) return exact;
  }
  let best: T | null = null;
  let bestLen = 0;
  for (const c of candidates) {
    const t = normalizeText(c.title);
    if (t.length < 3) continue;
    for (const n of normNames) {
      const contained = ` ${n} `.includes(` ${t} `);
      if (contained && t.length > bestLen) {
        best = c;
        bestLen = t.length;
      }
    }
  }
  return best;
}

export function routeSale(sale: RoutableSale, catalog: Catalog): RouteResult {
  const none: RouteResult = { bandId: null, releaseId: null, trackId: null, via: null };
  const key = routingKey(sale);

  // 1. Remembered manual mapping
  const override = catalog.overrides.find((o) => o.matchKey === key);
  if (override) {
    return { bandId: override.bandId, releaseId: override.releaseId, trackId: override.trackId, via: "override" };
  }

  const normUrl = sale.itemUrl ? normalizeUrl(sale.itemUrl) : "";

  // 2. Exact item URL match against the catalog
  if (normUrl) {
    const track = catalog.tracks.find((t) => t.url && normalizeUrl(t.url) === normUrl);
    if (track) return { bandId: track.bandId, releaseId: track.releaseId, trackId: track.id, via: "item_url" };
    const release = catalog.releases.find((r) => r.url && normalizeUrl(r.url) === normUrl);
    if (release) return { bandId: release.bandId, releaseId: release.id, trackId: null, via: "item_url" };
  }

  // 2b. Identifiers: ISRC → track; catalog number / UPC → release (and a track in it, by title)
  const isrc = normalizeId(sale.isrc);
  if (isrc.length >= 10) {
    const track = catalog.tracks.find((t) => normalizeId(t.isrc) === isrc);
    if (track) return { bandId: track.bandId, releaseId: track.releaseId, trackId: track.id, via: "identifier" };
  }
  const saleIds = [sale.catalogNumber, sale.upc].map(normalizeId).filter((x) => x.length >= 3);
  if (saleIds.length) {
    const release = catalog.releases.find((r) => (r.identifiers ?? []).some((x) => saleIds.includes(normalizeId(x))));
    if (release) {
      const track =
        sale.category === "track"
          ? bestTitleMatch(catalog.tracks.filter((t) => t.releaseId === release.id), sale.itemName)
          : null;
      return { bandId: track?.bandId ?? release.bandId, releaseId: release.id, trackId: track?.id ?? null, via: "identifier" };
    }
  }

  // 3. Band by URL pattern, then 4. by artist name
  let bandId: number | null = null;
  let via: RouteVia | null = null;
  if (normUrl) {
    const band = catalog.bands.find((b) => b.urlPatterns.some((p) => matchesBandPattern(normUrl, p)));
    if (band) {
      bandId = band.id;
      via = "band_url";
    }
  }
  if (bandId === null && sale.artist) {
    const a = normalizeText(sale.artist);
    const band = catalog.bands.find((b) => [b.name, ...b.aliases].some((n) => normalizeText(n) === a));
    if (band) {
      bandId = band.id;
      via = "artist";
    }
  }
  if (bandId === null) return none;

  // 5. Fuzzy title match inside the band
  const names = [sale.itemName, sale.packageName ?? ""];
  if (sale.category === "track") {
    const tracks = catalog.tracks.filter((t) => t.bandId === bandId);
    const track = bestTitleMatch(tracks, ...names);
    if (track) return { bandId, releaseId: track.releaseId, trackId: track.id, via };
  }
  const releases = catalog.releases.filter((r) => r.bandId === bandId);
  const release = bestTitleMatch(releases, ...names);
  if (release) return { bandId, releaseId: release.id, trackId: null, via };
  return { bandId, releaseId: null, trackId: null, via };
}
