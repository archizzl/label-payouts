/** Reading a public Bandcamp album or track page. */
import { artUrl, decodeEntities, imageUrl } from "./bandcamp-label";

export type ReleaseDetails = {
  bandcampId: number;
  /** merch: a standalone merch item; its sizes/options are in packages[0].options. */
  kind: "album" | "track" | "merch";
  title: string;
  artist: string | null;
  url: string;
  releaseDate: string | null; // ISO yyyy-mm-dd
  upc: string | null;
  catalogNumber: string | null;
  about: string | null;
  credits: string | null;
  tags: string[];
  artUrl: string | null;
  packages: {
    bandcampId: number;
    title: string;
    typeName: string | null;
    sku: string | null;
    upc: string | null;
    price: number | null;
    currency: string | null;
    /** Sizes, colours etc., each with its own SKU. */
    options?: { title: string; sku: string | null }[];
  }[];
  tracks: {
    bandcampId: number | null;
    position: number;
    title: string;
    durationSec: number | null;
    url: string | null;
    /** Only when the track credits a different artist than the release. */
    artist: string | null;
    isrc: string | null;
  }[];
};

type Tralbum = {
  id?: number;
  item_type?: string;
  artist?: string;
  url?: string;
  art_id?: number;
  album_release_date?: string | null;
  current?: {
    id?: number;
    title?: string;
    release_date?: string | null;
    publish_date?: string | null;
    upc?: string | null;
    isrc?: string | null;
    about?: string | null;
    credits?: string | null;
    art_id?: number;
  };
  packages?: {
    id: number;
    title?: string;
    type_name?: string;
    sku?: string | null;
    upc?: string | null;
    price?: number | null;
    currency?: string | null;
  }[] | null;
  trackinfo?: {
    id?: number;
    track_id?: number;
    track_num?: number | null;
    title?: string;
    duration?: number;
    title_link?: string | null;
    artist?: string | null;
  }[];
};

/** "22 Oct 2021 00:00:00 GMT" → "2021-10-22" */
export function bandcampDateToIso(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/** Format suffixes labels put on SKUs: "SBR-124-LP", "TP012CD", "ABC-44 7in". Sizes need "in" or ". */
const FORMAT_SUFFIX =
  /^(.*\d)[\s._-]*(?:\d?LP|CD|CS|MC|TAPE|CASS(?:ETTE)?|VINYL|(?:7|10|12)(?:IN|")|DLX|DELUXE|LTD|BOX|BLACK|COLOU?R|CLR|GOLD|SPLATTER)$/i;

/**
 * A release's catalog number, from its physical formats' SKUs: "SBR-278-LP", "SBR-278-CD" → "SBR-278".
 * A single SKU loses its format suffix. SKUs with nothing in common give null.
 */

export function deriveCatalogNumber(skus: (string | null | undefined)[]): string | null {
  const list = [...new Set(skus.map((s) => s?.trim()).filter((s): s is string => !!s))];
  if (list.length === 0) return null;
  if (list.length === 1) return list[0].match(FORMAT_SUFFIX)?.[1] ?? list[0];
  let prefix = list[0];
  for (const s of list.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i].toUpperCase() === s[i].toUpperCase()) i++;
    prefix = prefix.slice(0, i);
  }
  // Don't cut a number in half ("SBR-27" from "SBR-278" and "SBR-279").
  if (/\d$/.test(prefix) && list.some((s) => /\d/.test(s[prefix.length] ?? ""))) prefix = prefix.replace(/\d+$/, "");
  prefix = prefix.replace(/[^a-z0-9]+$/i, "");
  return prefix.length >= 3 && /\d/.test(prefix) ? prefix : null;
}

function clean(s: string | null | undefined): string | null {
  const v = (s ?? "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return v || null;
}

function keywordsFromLdJson(html: string): string[] {
  for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1]);
      const k = j.keywords;
      if (Array.isArray(k)) return k.map(String).map((s) => s.trim()).filter(Boolean);
      if (typeof k === "string") return k.split(",").map((s) => s.trim()).filter(Boolean);
    } catch {
      // ignore malformed blocks
    }
  }
  return [];
}

export function parseReleasePage(html: string, pageUrl: string): ReleaseDetails | null {
  const raw = html.match(/data-tralbum="([^"]*)"/)?.[1];
  if (!raw) return null;
  let t: Tralbum;
  try {
    t = JSON.parse(decodeEntities(raw));
  } catch {
    return null;
  }
  if (t.item_type === "package" || /\/merch\//.test(pageUrl)) return parseMerch(t, html, pageUrl);
  const cur = t.current ?? {};
  const kind = t.item_type === "track" ? "track" : "album";
  const base = t.url ?? pageUrl;
  const abs = (href: string | null | undefined) => {
    if (!href) return null;
    try {
      const u = new URL(href, base);
      return `https://${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
    } catch {
      return null;
    }
  };
  const releaseArtist = t.artist?.trim() || null;
  const packages = (t.packages ?? []).map((p) => ({
    bandcampId: p.id,
    title: (p.title ?? "").trim(),
    typeName: p.type_name ?? null,
    sku: p.sku?.trim() || null,
    upc: p.upc?.trim() || null,
    price: typeof p.price === "number" ? p.price : null,
    currency: p.currency ?? null,
  }));
  const tracks = (t.trackinfo ?? []).map((tr, i) => {
    const artist = tr.artist?.trim() || null;
    return {
      bandcampId: tr.track_id ?? tr.id ?? null,
      position: tr.track_num ?? i + 1,
      title: (tr.title ?? "").trim(),
      durationSec: typeof tr.duration === "number" && tr.duration > 0 ? Math.round(tr.duration) : null,
      url: abs(tr.title_link),
      artist: artist && artist !== releaseArtist ? artist : null,
      isrc: kind === "track" ? cur.isrc?.trim() || null : null,
    };
  });
  return {
    bandcampId: t.id ?? cur.id ?? 0,
    kind,
    title: (cur.title ?? tracks[0]?.title ?? "").trim(),
    artist: releaseArtist,
    url: abs(t.url) ?? abs(pageUrl)!,
    releaseDate: bandcampDateToIso(t.album_release_date ?? cur.release_date ?? cur.publish_date),
    upc: cur.upc?.trim() || null,
    catalogNumber: deriveCatalogNumber(packages.map((p) => p.sku)),
    about: clean(cur.about),
    credits: clean(cur.credits),
    tags: keywordsFromLdJson(html),
    artUrl: artUrl(t.art_id ?? cur.art_id, 16),
    packages,
    tracks: tracks.filter((tr) => tr.title),
  };
}

type MerchTralbum = {
  current?: {
    id?: number;
    title?: string;
    type_name?: string;
    sku?: string | null;
    upc?: string | null;
    price?: number | null;
    currency?: string | null;
    description?: string | null;
    new_date?: string | null;
    release_date?: string | null;
    album_artist?: string | null;
    url?: string | null;
    arts?: { image_id?: number }[];
    options?: { title?: string; sku?: string | null }[] | null;
  };
};

function bandNameFromPage(html: string): string | null {
  const blob = html.match(/data-band="([^"]*)"/)?.[1];
  if (!blob) return null;
  try {
    const name = JSON.parse(decodeEntities(blob)).name;
    return typeof name === "string" && name ? name : null;
  } catch {
    return null;
  }
}

/** A standalone merch item page (shirt, poster, bundle…). */
function parseMerch(t: MerchTralbum, html: string, pageUrl: string): ReleaseDetails | null {
  const cur = t.current;
  if (!cur?.id || !cur.title) return null;
  let url: string;
  try {
    const u = new URL(cur.url ?? pageUrl, pageUrl);
    url = `https://${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
  const options = (cur.options ?? [])
    .map((o) => ({ title: (o.title ?? "").trim(), sku: o.sku?.trim() || null }))
    .filter((o) => o.title);
  return {
    bandcampId: cur.id,
    kind: "merch",
    title: cur.title.trim(),
    artist: cur.album_artist?.trim() || bandNameFromPage(html),
    url,
    releaseDate: bandcampDateToIso(cur.release_date ?? cur.new_date),
    upc: cur.upc?.trim() || null,
    catalogNumber: null,
    about: clean(cur.description),
    credits: null,
    tags: [],
    artUrl: imageUrl(cur.arts?.[0]?.image_id, 10),
    packages: [
      {
        bandcampId: cur.id,
        title: cur.title.trim(),
        typeName: cur.type_name ?? null,
        sku: cur.sku?.trim() || null,
        upc: cur.upc?.trim() || null,
        price: typeof cur.price === "number" ? cur.price : null,
        currency: cur.currency ?? null,
        ...(options.length ? { options } : {}),
      },
    ],
    tracks: [],
  };
}
