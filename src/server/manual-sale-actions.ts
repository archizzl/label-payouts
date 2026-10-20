"use server";

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { MANUAL_IMPORT, MANUAL_KINDS, MANUAL_SOURCE, MANUAL_VIA } from "@/lib/manual-sales";
import { parseCents } from "@/lib/money";
import { plural } from "@/lib/plural";
import { saleInPayout } from "./sales-browse";
import { merchSources, saleAdder } from "./manual-sales";
import { takeStock } from "./inventory";
import { importNamed } from "./import-rows";
import { onLabelSince } from "./own-books";

export type ManualSaleState = { ok?: string; error?: string } | null;

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** Add a sale by hand (a show, merch sold in person): counted like any other sale, for the band chosen. */
export async function addManualSale(_: ManualSaleState, fd: FormData): Promise<ManualSaleState> {
  const adder = await saleAdder();
  if (!adder) return { error: "Only a band’s members can add its sales." };
  const { orgId, user, managedBy } = adder.ctx;
  const date = str(fd, "date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "Enter the date." };
  const bandId = Number(str(fd, "bandId")) || null;
  if (!bandId) return { error: "Choose the band." };
  const band = adder.bands.find((b) => b.id === bandId);
  if (!band) return { error: "That isn’t one of your bands." };
  const kind = MANUAL_KINDS.find((k) => k.value === str(fd, "kind"));
  if (!kind) return { error: "Choose what it was." };
  const currency = (str(fd, "currency") || "USD").toUpperCase().slice(0, 3);

  // What was sold: merch is a line per item sold (from the catalog, or "something else"); a show
  // or anything else is one line.
  type Line = { itemName: string; format: string; release: { books: string; id: number } | null; netCents: number; quantity: number; stock?: { id: number; orgId: string } | null };
  const lines: Line[] = [];
  if (kind.value === "merch") {
    const sold = [...fd.keys()]
      .filter((k) => k.startsWith("sold:"))
      .map((k) => ({ ref: k.slice("sold:".length), quantity: Math.round(Number(str(fd, k)) || 0) }))
      .filter((x) => x.quantity > 0);
    const entries = await merchSources({ orgId, managed: managedBy ? { labelOrgId: managedBy.labelOrgId, bandId: managedBy.bandId } : null, onlyBands: adder.onlyBands });
    for (const { ref, quantity } of sold) {
      const each = parseCents(str(fd, `each:${ref}`));
      if (ref === "other") {
        const itemName = str(fd, "name:other").slice(0, 200);
        if (!itemName) return { error: "Say what the something else was." };
        if (!each) return { error: `Enter the price of ${itemName}.` };
        lines.push({ itemName, format: "", release: null, netCents: each * quantity, quantity });
        continue;
      }
      // (Its own books' items must be the band's; the label's are all for the band.)
      const entry = entries.find((e) => e.value === ref);
      if (!entry || (entry.bandId !== null && entry.bandId !== bandId)) return { error: "That item isn’t the band’s." };
      if (!each) return { error: `Enter the price of ${entry.format ? `${entry.itemName}, ${entry.format}` : entry.itemName}.` };
      lines.push({
        itemName: entry.itemName,
        format: entry.format,
        release: entry.releaseId ? { books: entry.books, id: entry.releaseId } : null,
        netCents: each * quantity,
        quantity,
        stock: entry.stock,
      });
    }
    if (!lines.length) return { error: "Enter how many of something were sold." };
  } else {
    const itemName = str(fd, "itemName").slice(0, 200);
    if (!itemName) return { error: "Say what it was." };
    const netCents = parseCents(str(fd, "amount"));
    if (!netCents) return { error: "Enter the amount." };
    lines.push({ itemName, format: "", release: null, netCents, quantity: Math.max(1, Math.round(Number(str(fd, "quantity")) || 1)) });
  }

  // A band's own group on a label: from its time on the label, its sales are the label's, for its band there.
  const since = managedBy ? await onLabelSince(managedBy.labelOrgId, managedBy.bandId) : null;
  const books = managedBy && (!since || date >= since) ? { orgId: managedBy.labelOrgId, bandId: managedBy.bandId } : { orgId, bandId };
  const importId = await importNamed(books.orgId, MANUAL_IMPORT);
  await db.transaction(async (tx) => {
    const added = await tx
      .insert(schema.sales)
      .values(
        lines.map((l) => {
          const key = `manual:${randomUUID()}`;
          return {
            orgId: books.orgId,
            importId,
            dedupeKey: key,
            date,
            itemType: kind.itemType,
            category: kind.category,
            itemName: l.itemName,
            artist: band.name,
            itemUrl: "",
            packageName: l.format,
            currency,
            netCents: l.netCents,
            quantity: l.quantity,
            transactionId: key,
            routingKey: key,
            bandId: books.bandId,
            releaseId: l.release?.books === books.orgId ? l.release.id : null,
            routedVia: MANUAL_VIA,
            raw: { source: MANUAL_SOURCE, kind: kind.label, "added by": user.name },
          };
        }),
      )
      .returning({ id: schema.sales.id });
    // What was sold comes off its stock, linked to the sale so deleting it puts it back.
    for (const [i, l] of lines.entries()) {
      if (l.stock) await takeStock(tx, l.stock, "sold", l.quantity, { saleId: added[i].id, userId: user.id, note: `From a sale on ${date}` });
    }
  });
  revalidatePath("/", "layout");
  if (lines.length > 1) return { ok: `Added ${plural(lines.length, "sale")}.` };
  return { ok: `Added ${lines[0].format ? `${lines[0].itemName}, ${lines[0].format}` : lines[0].itemName}.` };
}

/** Take back a sale that was added by hand, while it isn't part of a payout yet. */
export async function deleteManualSale(_: ManualSaleState, fd: FormData): Promise<ManualSaleState> {
  const adder = await saleAdder();
  if (!adder) return { error: "Only a band’s members can delete its sales." };
  const { orgId, managedBy, user } = adder.ctx;
  const userId = user.id;
  const id = Number(str(fd, "id"));
  // (A band's own group: its own books, or the label's for its band.)
  const [sale] = await db
    .select({ id: schema.sales.id, orgId: schema.sales.orgId, bandId: schema.sales.bandId, via: schema.sales.routedVia })
    .from(schema.sales)
    .where(eq(schema.sales.id, id));
  const ours =
    sale &&
    ((sale.orgId === orgId && adder.bands.some((b) => b.id === sale.bandId)) || (managedBy && sale.orgId === managedBy.labelOrgId && sale.bandId === managedBy.bandId));
  if (!sale || !ours) return { error: "That isn’t one of your band’s sales." };
  if (sale.via !== MANUAL_VIA) return { error: "Only sales added by hand can be deleted." };
  if (await saleInPayout(sale.orgId, id)) return { error: "It’s part of a payout already, so it stays." };
  await db.transaction(async (tx) => {
    // What it took off stock goes back.
    const moves = await tx.select().from(schema.inventoryMoves).where(eq(schema.inventoryMoves.saleId, id));
    for (const m of moves) {
      await takeStock(tx, { id: m.itemId, orgId: m.orgId }, "other", -m.delta, { saleId: null, userId, note: "Back in stock: the sale was deleted" });
    }
    await tx.delete(schema.sales).where(and(eq(schema.sales.orgId, sale.orgId), eq(schema.sales.id, id)));
  });
  revalidatePath("/", "layout");
  return { ok: "Deleted." };
}
