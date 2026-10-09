/** Reading a label's public Bandcamp "artists" page (https://<label>.bandcamp.com/artists). */

export type LabelArtist = {
  name: string;
  /** Artist page, without query string, e.g. https://blackmarble.bandcamp.com */
  url: string;
  /** What to store as the band's URL pattern: the bandcamp subdomain, or the custom host. */
  urlPattern: string;
  location: string | null;
  imageUrl: string | null;
};

/**
 * Accepts "mylabel", "mylabel.bandcamp.com", "https://mylabel.bandcamp.com/music" or a custom
 * domain, and returns the label's artists-page URL. Returns null if it can't be a URL.
 */
export function labelArtistsUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (/^[a-z0-9-]+$/i.test(s)) s = `${s}.bandcamp.com`;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname.includes(".")) return null;
    return `https://${u.hostname.toLowerCase()}/artists`;
  } catch {
    return null;
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    if (ENTITIES[e.toLowerCase()]) return ENTITIES[e.toLowerCase()];
    // Accented letters: &eacute; &Ouml; &ntilde; &ccedil; &aring; …
    const accent = e.match(/^([a-z])(acute|grave|circ|uml|tilde|cedil|ring)$/i);
    return accent ? (accent[1] + ACCENTS[accent[2].toLowerCase()]).normalize("NFC") : m;
  });
}

const ACCENTS: Record<string, string> = {
  acute: "́",
  grave: "̀",
  circ: "̂",
  uml: "̈",
  tilde: "̃",
  cedil: "̧",
  ring: "̊",
};

function urlPatternFor(url: string): string {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  const m = host.match(/^([a-z0-9-]+)\.bandcamp\.com$/);
  return m ? m[1] : host;
}

/** Pull the artist grid out of the page HTML. Order is kept; duplicates are dropped. */
export function parseLabelArtists(html: string): LabelArtist[] {
  const out: LabelArtist[] = [];
  const seen = new Set<string>();
  // <a href='https://x.bandcamp.com?label=…&amp;tab=artists'> <img …> <div class="artists-grid-name">Name</div> </a>
  // then optionally <div class="artists-grid-location secondaryText">City</div>
  const re =
    /<a\s+href=(["'])([^"']+)\1[^>]*>((?:(?!<\/a>)[\s\S])*?class="artists-grid-name"[\s\S]*?)<\/a>(\s*<div class="artists-grid-location[^"]*"[^>]*>([\s\S]*?)<\/div>)?/g;
  for (const m of html.matchAll(re)) {
    const inner = m[3];
    const nameHtml = inner.match(/class="artists-grid-name"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
    const name = textOf(nameHtml);
    let url: string;
    try {
      const u = new URL(decodeEntities(m[2]));
      url = `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`;
    } catch {
      continue;
    }
    if (!name || seen.has(url)) continue;
    seen.add(url);
    const location = m[5] ? textOf(m[5]) || null : null;
    out.push({ name, url, urlPattern: urlPatternFor(url), location, imageUrl: imgSrc(inner) });
  }
  return out;
}

function textOf(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** First image in a fragment; lazy-loaded images keep the real URL in data-original. */
function imgSrc(fragment: string): string | null {
  const tag = fragment.match(/<img\b[^>]*>/)?.[0];
  if (!tag) return null;
  const src = tag.match(/data-original=["']([^"']+)["']/)?.[1] ?? tag.match(/\ssrc=["']([^"']+)["']/)?.[1];
  return src && !src.includes("/img/0.gif") && !src.startsWith("data:") ? decodeEntities(src) : null;
}

/**
 * The account's profile photo, from the bio sidebar every Bandcamp page has
 * (<img class="band-photo" src=".../img/0047556316_21.jpg">). Returned in the same 400px crop the
 * label's artist grid uses, so the label's picture matches its bands'.
 */
export function parseBandPhoto(html: string): string | null {
  // "bio-pic" on an artist's page with no music on it yet.
  const tag = html.match(/<img\b[^>]*class="(?:band-photo|bio-pic)"[^>]*>/)?.[0];
  const id = tag?.match(/\/img\/(\d+)_\d+\./)?.[1];
  return id ? `https://f4.bcbits.com/img/${id}_36.jpg` : null;
}

/** Bandcamp merch photo URL for an image id (merch photos have no "a" prefix, unlike album art). */
export function imageUrl(imageId: number | null | undefined, size: 2 | 3 | 10 | 16 = 2): string | null {
  if (!imageId) return null;
  return `https://f4.bcbits.com/img/${String(imageId).padStart(10, "0")}_${size}.jpg`;
}

/** Bandcamp cover art URL for an art id. Size 2 is 350px, 16 is 700px, 10 is the original. */
export function artUrl(artId: number | null | undefined, size: 2 | 10 | 16 = 2): string | null {
  if (!artId) return null;
  return `https://f4.bcbits.com/img/a${String(artId).padStart(10, "0")}_${size}.jpg`;
}

export function labelMusicUrl(input: string): string | null {
  const u = labelArtistsUrl(input);
  return u ? u.replace(/\/artists$/, "/music") : null;
}

export type LabelRelease = {
  bandcampId: number;
  /** merch: a standalone merch item (shirt, poster…), not a format of a release. */
  kind: "album" | "track" | "merch";
  title: string;
  artist: string | null;
  /** Release page, without query string. */
  url: string;
  artUrl: string | null;
};

function cleanUrl(href: string, base: string): string | null {
  try {
    const u = new URL(decodeEntities(href), base);
    return `https://${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/**
 * Every release on a label's /music page. The first few are rendered as HTML, the rest are
 * embedded as JSON in data-client-items; both are read.
 */
export function parseLabelMusic(html: string, pageUrl: string): LabelRelease[] {
  const out: LabelRelease[] = [];
  const seen = new Set<string>();
  const push = (r: LabelRelease | null) => {
    if (!r || !r.title || seen.has(`${r.kind}-${r.bandcampId}`)) return;
    seen.add(`${r.kind}-${r.bandcampId}`);
    out.push(r);
  };

  for (const m of html.matchAll(/<li[^>]*?data-item-id="(album|track)-(\d+)"([\s\S]*?)<\/li>/g)) {
    const body = m[3];
    const href = body.match(/<a\s+href=["']([^"']+)["']/)?.[1];
    const titleHtml = body.match(/<p class="title">([\s\S]*?)<\/p>/)?.[1] ?? "";
    const [titlePart, ...rest] = titleHtml.split(/<br\s*\/?>/i);
    const artistHtml = rest.join(" ").match(/class="artist-override"[^>]*>([\s\S]*?)<\/span>/)?.[1];
    const url = href ? cleanUrl(href, pageUrl) : null;
    if (!url) continue;
    push({
      bandcampId: Number(m[2]),
      kind: m[1] as "album" | "track",
      title: textOf(titlePart),
      artist: artistHtml ? textOf(artistHtml) || null : null,
      url,
      artUrl: imgSrc(body),
    });
  }

  const blob = html.match(/data-client-items="([^"]*)"/)?.[1];
  if (blob) {
    try {
      const items = JSON.parse(decodeEntities(blob)) as {
        id: number;
        type: string;
        title: string;
        artist?: string;
        page_url: string;
        art_id?: number;
      }[];
      for (const it of items) {
        const url = cleanUrl(it.page_url, pageUrl);
        if (!url || (it.type !== "album" && it.type !== "track")) continue;
        push({
          bandcampId: it.id,
          kind: it.type as "album" | "track",
          title: (it.title ?? "").trim(),
          artist: it.artist?.trim() || null,
          url,
          artUrl: artUrl(it.art_id),
        });
      }
    } catch {
      // malformed blob: keep what the HTML gave us
    }
  }
  return out;
}

export function labelMerchUrl(input: string): string | null {
  const u = labelArtistsUrl(input);
  return u ? u.replace(/\/artists$/, "/merch") : null;
}

/**
 * Standalone merch on a label's /merch page (items with their own /merch/… page). Formats of a
 * release (vinyl, CD, tape) link to the album instead and come in with the release, so they're
 * skipped here. Like /music, the first items are HTML and the rest are JSON in data-client-items.
 */
export function parseLabelMerch(html: string, pageUrl: string): LabelRelease[] {
  const out: LabelRelease[] = [];
  const seen = new Set<string>();
  const push = (r: LabelRelease | null) => {
    if (!r || !r.title || !/\/merch\//.test(r.url) || seen.has(r.url)) return;
    seen.add(r.url);
    out.push(r);
  };

  for (const m of html.matchAll(/<li[^>]*?data-item-id="(\d+)"[^>]*class="merch-grid-item([\s\S]*?)<\/li>/g)) {
    const body = m[2];
    const href = body.match(/<a\s+href=["']([^"']+)["']/)?.[1];
    const url = href ? cleanUrl(href, pageUrl) : null;
    if (!url) continue;
    const titleHtml = body.match(/<p class="title">([\s\S]*?)<\/p>/)?.[1] ?? "";
    const [titlePart, ...rest] = titleHtml.split(/<br\s*\/?>/i);
    const artistHtml = rest.join(" ").match(/class="artist-override"[^>]*>([\s\S]*?)<\/span>/)?.[1];
    push({
      bandcampId: Number(m[1]),
      kind: "merch",
      title: textOf(titlePart).replace(/\s+–$/, ""),
      artist: artistHtml ? textOf(artistHtml) || null : null,
      url,
      artUrl: imgSrc(body),
    });
  }

  const blob = html.match(/data-client-items="([^"]*)"/)?.[1];
  if (blob) {
    try {
      const items = JSON.parse(decodeEntities(blob)) as { id: number; title: string; album_artist?: string; url: string; img_id?: number }[];
      for (const it of items) {
        const url = cleanUrl(it.url, pageUrl);
        if (!url) continue;
        push({
          bandcampId: it.id,
          kind: "merch",
          title: (it.title ?? "").trim(),
          artist: it.album_artist?.trim() || null,
          url,
          artUrl: imageUrl(it.img_id),
        });
      }
    } catch {
      // malformed blob: keep what the HTML gave us
    }
  }
  return out;
}

/** The label's own name, from the page's data-band blob or <title>. */
export function parseLabelName(html: string): string | null {
  const blob = html.match(/data-band="([^"]*)"/);
  if (blob) {
    try {
      const name = JSON.parse(decodeEntities(blob[1])).name;
      if (typeof name === "string" && name) return name;
    } catch {
      // fall through
    }
  }
  const title = html.match(/<title>([^<]*)<\/title>/i);
  return title ? decodeEntities(title[1]).split("|").pop()!.trim() || null : null;
}
