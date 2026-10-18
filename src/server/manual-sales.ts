import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import type { MerchChoice } from "@/components/manual-sale-fields";
import type { ReleasePackage } from "@/db/schema";

/*
 * The merch a sale added by hand can be for, sold out or not: merch items and releases' physical
 * formats from the catalog, and stock that isn't in the catalog. For a band account the label made,
 * the label's for its band too (its merch is usually in the label's catalog and stock).
 */

type Books = { orgId: string; managed: { labelOrgId: string; bandId: number } | null; onlyBands?: number[] | null };

export async function merchSources({ orgId, managed, onlyBands }: Books) {
  // Own books (limited to someone's own bands, if they are), and the label's for its band.
  const places = [
    { orgId, bandIds: onlyBands ?? null, own: true },
    ...(managed ? [{ orgId: managed.labelOrgId, bandIds: [managed.bandId], own: false }] : []),
  ];
  const parts = await Promise.all(
    places.map(async (p) => {
      const inBands = <T extends typeof schema.releases.bandId | typeof schema.inventoryItems.bandId>(col: T) =>
        p.bandIds ? inArray(col, p.bandIds.length ? p.bandIds : [-1]) : undefined;
      const [releases, stock] = await Promise.all([
        db
          .select({ id: schema.releases.id, title: schema.releases.title, kind: schema.releases.kind, bandId: schema.releases.bandId, packages: schema.releases.packages })
          .from(schema.releases)
          .where(and(eq(schema.releases.orgId, p.orgId), inBands(schema.releases.bandId)))
          .orderBy(asc(schema.releases.title)),
        db
          .select({
            id: schema.inventoryItems.id,
            name: schema.inventoryItems.name,
            option: schema.inventoryItems.option,
            bandId: schema.inventoryItems.bandId,
            priceCents: schema.inventoryItems.priceCents,
            releaseId: schema.inventoryItems.releaseId,
            packageId: schema.inventoryItems.packageId,
          })
          .from(schema.inventoryItems)
          .where(
            and(
              eq(schema.inventoryItems.orgId, p.orgId),
              eq(schema.inventoryItems.kind, "product"),
              eq(schema.inventoryItems.archived, false),
              inBands(schema.inventoryItems.bandId),
            ),
          )
          .orderBy(asc(schema.inventoryItems.name)),
      ]);
      // Stock of a catalog item is already listed as that item. Its price, if set, is what it sells
      // for in person, which goes before Bandcamp's.
      const inPerson = new Map<string, number>();
      for (const s of stock) if (s.releaseId !== null && s.priceCents !== null) inPerson.set(`${s.releaseId}:${s.packageId ?? ""}`, s.priceCents / 100);
      const priceOf = (releaseId: number, pkg?: ReleasePackage) => inPerson.get(`${releaseId}:${pkg?.bandcampId ?? ""}`) ?? pkg?.price ?? null;
      return {
        releases: releases
          .filter((r) => r.kind === "merch" || r.packages.length)
          .map((r) => ({ ...r, own: p.own, price: priceOf(r.id), packages: r.packages.map((pkg) => ({ ...pkg, price: priceOf(r.id, pkg) })) })),
        stock: stock.filter((s) => s.releaseId === null).map((s) => ({ ...s, own: p.own })),
      };
    }),
  );
  return { releases: parts.flatMap((p) => p.releases), stock: parts.flatMap((p) => p.stock) };
}

export type MerchSources = Awaited<ReturnType<typeof merchSources>>;

/**
 * What a merch item is called on a sale: the release, and the format beside it (unless it's the item
 * itself; "Triple Single CD" on Triple Single is just "CD").
 */
export function merchName(release: { title: string }, pkg?: { title: string }) {
  if (!pkg || pkg.title === release.title) return { itemName: release.title, format: "" };
  const rest = pkg.title.startsWith(`${release.title} `) ? pkg.title.slice(release.title.length + 1).replace(/^[-–—:]\s*/, "") : "";
  return { itemName: release.title, format: rest || pkg.title };
}

/**
 * The list to pick from: "<release id>:<package id>" (or "<release id>:") for the catalog,
 * "stock:<id>" for stock. The label's are for the band whichever band's picked (it has one).
 */
export function merchChoices({ releases, stock }: MerchSources): MerchChoice[] {
  const bandOf = (x: { own: boolean; bandId: number | null }) => (x.own ? x.bandId : null);
  return [
    ...releases.flatMap((r) => {
      if (r.kind === "merch" && !r.packages.length) return [{ value: `${r.id}:`, label: r.title, bandId: bandOf(r), price: r.price }];
      return r.packages.map((p) => {
        const { itemName, format } = merchName(r, p);
        return { value: `${r.id}:${p.bandcampId}`, label: format ? `${itemName} — ${format}` : itemName, bandId: bandOf(r), price: p.price };
      });
    }),
    ...stock.map((s) => ({
      value: `stock:${s.id}`,
      label: s.option ? `${s.name} (${s.option})` : s.name,
      bandId: bandOf(s),
      price: s.priceCents !== null ? s.priceCents / 100 : null,
    })),
  ].sort((a, b) => a.label.localeCompare(b.label));
}
