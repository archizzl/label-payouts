import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import type { MerchChoice } from "@/components/manual-sale-fields";

/*
 * The merch a sale added by hand can be for, sold out or not: merch items and releases' physical
 * formats from the catalog (each size or colour stocked on its own line), and stock that isn't in the
 * catalog. For a band account the label made, the label's for its band too (its merch is usually in
 * the label's catalog and stock). A stock count's price, if set, is what it sells for in person,
 * which goes before Bandcamp's; selling takes it off that count.
 */

type Books = { orgId: string; managed: { labelOrgId: string; bandId: number } | null; onlyBands?: number[] | null };

export async function merchSources({ orgId, managed, onlyBands }: Books) {
  // Own books (limited to someone's own bands, if they are), and the label's for its band.
  const places = [
    { orgId, bandIds: onlyBands ?? null, own: true },
    ...(managed ? [{ orgId: managed.labelOrgId, bandIds: [managed.bandId], own: false }] : []),
  ];
  const parts = await Promise.all(
    places.map(async (p): Promise<MerchEntry[]> => {
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
      const entries: MerchEntry[] = [];
      const bandId = (x: { bandId: number | null }) => (p.own ? x.bandId : null);
      const stockOf = (x: { id: number }) => ({ id: x.id, orgId: p.orgId });
      for (const r of releases) {
        if (r.kind !== "merch" && !r.packages.length) continue;
        for (const pkg of r.kind === "merch" && !r.packages.length ? [undefined] : r.packages) {
          const { itemName, format } = merchName(r, pkg);
          // Its stock: one count, or one per size or colour (each its own line).
          const counted = stock.filter((x) => x.releaseId === r.id && (x.packageId ?? null) === (pkg?.bandcampId ?? null));
          if (counted.length <= 1) {
            const c = counted[0];
            const price = c?.priceCents != null ? c.priceCents / 100 : (pkg?.price ?? null);
            entries.push({ value: `${r.id}:${pkg?.bandcampId ?? ""}`, itemName, format, releaseId: p.own ? r.id : null, bandId: bandId(r), price, stock: c ? stockOf(c) : null });
          } else {
            for (const c of counted) {
              const sized = c.option ? (format ? `${format}, ${c.option}` : c.option) : format;
              const price = c.priceCents != null ? c.priceCents / 100 : (pkg?.price ?? null);
              entries.push({ value: `stock:${c.id}`, itemName, format: sized, releaseId: p.own ? r.id : null, bandId: bandId(r), price, stock: stockOf(c) });
            }
          }
        }
      }
      // Stock that isn't in the catalog.
      for (const c of stock.filter((x) => x.releaseId === null)) {
        const price = c.priceCents != null ? c.priceCents / 100 : null;
        entries.push({ value: `stock:${c.id}`, itemName: c.option ? `${c.name} (${c.option})` : c.name, format: "", releaseId: null, bandId: bandId(c), price, stock: stockOf(c) });
      }
      return entries;
    }),
  );
  return parts.flat().sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
}

/**
 * Something to sell: its value in the form ("<release id>:<package id>", or "stock:<id>" for a
 * size of an item or stock outside the catalog), what the sale is called, the catalog item it's
 * linked to (its own books' only: the label's catalog is the label's), its band (its own books'
 * only), the price each, and the stock it comes off.
 */
export type MerchEntry = {
  value: string;
  itemName: string;
  format: string;
  releaseId: number | null;
  bandId: number | null;
  price: number | null;
  stock: { id: number; orgId: string } | null;
};

const labelOf = (e: { itemName: string; format: string }) => (e.format ? `${e.itemName} — ${e.format}` : e.itemName);

/**
 * What a merch item is called on a sale: the release, and the format beside it (unless it's the item
 * itself; "Triple Single CD" on Triple Single is just "CD").
 */
export function merchName(release: { title: string }, pkg?: { title: string }) {
  if (!pkg || pkg.title === release.title) return { itemName: release.title, format: "" };
  const rest = pkg.title.startsWith(`${release.title} `) ? pkg.title.slice(release.title.length + 1).replace(/^[-–—:]\s*/, "") : "";
  return { itemName: release.title, format: rest || pkg.title };
}

/** The list to pick from, for the form. */
export function merchChoices(entries: MerchEntry[]): MerchChoice[] {
  return entries.map((e) => ({ value: e.value, label: labelOf(e), bandId: e.bandId, price: e.price }));
}
