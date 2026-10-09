import "server-only";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import type { ReleasePackage } from "@/db/schema";
import { normalizeText } from "@/lib/routing";
import { type BandcampAccountBand, type BandcampCredentials, merchDetails } from "./bandcamp-api";
import { reRouteAll } from "./data";

/*
 * Keeping the catalog up to date through Bandcamp's official API, for where its public pages can't
 * be read (Bandcamp shows cloud servers a bot check instead). The API covers the artists, every
 * merch item and physical format, and (from sales) releases as they sell. It has no track lists,
 * artwork or release dates: `npm run sync-catalog` on a Mac fills those in from the public pages.
 */

const { bands, releases, sales } = schema;
const same = (a: string, b: string) => normalizeText(a) === normalizeText(b);

/** A label's artists, from the API's account details: add the new ones, link existing bands to their Bandcamp page. */
export async function artistsFromApi(orgId: string, accounts: BandcampAccountBand[]) {
  let added = 0;
  let linked = 0;
  const members = accounts.flatMap((a) => a.member_bands ?? []);
  for (const m of members) {
    const pattern = m.subdomain.toLowerCase();
    const current = await db.select().from(bands).where(eq(bands.orgId, orgId));
    if (current.some((b) => b.urlPatterns.some((p) => p.toLowerCase() === pattern))) continue;
    const byName = current.find((b) => [b.name, ...b.aliases].some((n) => same(n, m.name)));
    if (byName) {
      await db.update(bands).set({ urlPatterns: [...byName.urlPatterns, pattern] }).where(eq(bands.id, byName.id));
      linked++;
    } else {
      await db.insert(bands).values({ orgId, name: m.name, urlPatterns: [pattern] });
      added++;
    }
  }
  return { added, linked };
}

const asPackage = (m: Awaited<ReturnType<typeof merchDetails>>[number]): ReleasePackage => ({
  bandcampId: m.package_id,
  title: m.title,
  typeName: null,
  sku: m.sku ?? null,
  upc: null,
  price: m.price ?? null,
  currency: m.currency ?? null,
  ...(m.options?.length ? { options: m.options.map((o) => ({ title: o.title, sku: o.sku ?? null })) } : {}),
});

/**
 * Merch and physical formats, from the merch API. A music format (it has an album title) is added
 * to that album's formats; anything else becomes a merch item. Nothing already here is duplicated.
 */
export async function merchFromApi(orgId: string, creds: BandcampCredentials, accounts: BandcampAccountBand[]) {
  let formats = 0;
  let merch = 0;
  const items = new Map<number, Awaited<ReturnType<typeof merchDetails>>[number]>();
  for (const a of accounts) for (const m of await merchDetails(orgId, creds, a.band_id)) items.set(m.package_id, m);

  const bandRows = await db.select().from(bands).where(eq(bands.orgId, orgId));
  const labelBand = bandRows.find((b) => b.isLabel) ?? null;
  const ownSubdomains = new Set(accounts.map((a) => a.subdomain.toLowerCase()));
  const bandFor = (subdomain: string | null | undefined) => {
    const s = (subdomain ?? "").toLowerCase();
    return bandRows.find((b) => b.urlPatterns.some((p) => p.toLowerCase() === s)) ?? (ownSubdomains.has(s) ? labelBand : null);
  };

  for (const m of items.values()) {
    const band = bandFor(m.subdomain);
    if (!band) continue; // an artist we don't know yet: picked up once the artist is added
    const all = await db.select().from(releases).where(and(eq(releases.orgId, orgId), eq(releases.bandId, band.id)));
    const already = all.some((r) => r.bandcampId === m.package_id || r.packages.some((p) => p.bandcampId === m.package_id));
    if (already) continue;
    if (m.album_title) {
      const album = all.find((r) => r.kind !== "merch" && same(r.title, m.album_title!));
      if (!album) continue; // the album isn't in the catalog yet; it'll come with its first sale or a catalog sync
      await db.update(releases).set({ packages: [...album.packages, asPackage(m)] }).where(eq(releases.id, album.id));
      formats++;
    } else {
      const byTitle = all.find((r) => r.kind === "merch" && same(r.title, m.title));
      if (byTitle) {
        await db.update(releases).set({ bandcampId: byTitle.bandcampId ?? m.package_id, packages: byTitle.packages.length ? byTitle.packages : [asPackage(m)] }).where(eq(releases.id, byTitle.id));
        continue;
      }
      await db.insert(releases).values({
        orgId,
        bandId: band.id,
        title: m.title,
        kind: "merch",
        bandcampId: m.package_id,
        artUrl: m.image_url ?? null,
        packages: [asPackage(m)],
      });
      merch++;
    }
  }
  if (formats || merch) await reRouteAll(orgId);
  return { formats, merch };
}

/**
 * Albums that have sold but aren't in the catalog yet: add them (title and Bandcamp address, from
 * the sale), so their sales are matched. Tracks are left alone: a track might belong to an album
 * that isn't here yet, which only its page can tell.
 */
export async function releasesFromSales(orgId: string) {
  const loose = await db
    .select({ bandId: sales.bandId, itemName: sales.itemName, itemUrl: sales.itemUrl })
    .from(sales)
    .where(and(eq(sales.orgId, orgId), isNull(sales.releaseId), isNotNull(sales.bandId), eq(sales.category, "album")));
  const byUrl = new Map<string, { bandId: number; title: string }>();
  for (const s of loose) if (s.itemUrl && /\/album\//.test(s.itemUrl) && !byUrl.has(s.itemUrl)) byUrl.set(s.itemUrl, { bandId: s.bandId!, title: s.itemName });
  if (!byUrl.size) return { added: 0 };
  const existing = await db.select({ url: releases.url }).from(releases).where(and(eq(releases.orgId, orgId), inArray(releases.url, [...byUrl.keys()])));
  const have = new Set(existing.map((r) => r.url));
  let added = 0;
  for (const [url, r] of byUrl) {
    if (have.has(url)) continue;
    await db.insert(releases).values({ orgId, bandId: r.bandId, title: r.title, url, kind: "album" });
    added++;
  }
  if (added) await reRouteAll(orgId);
  return { added };
}
