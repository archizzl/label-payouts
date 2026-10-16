"use server";

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { MANUAL_IMPORT, MANUAL_KINDS, MANUAL_SOURCE, MANUAL_VIA } from "@/lib/manual-sales";
import { parseCents } from "@/lib/money";
import { bandScope } from "@/lib/permissions";
import { requireAccess } from "./context";
import { saleInPayout } from "./sales-browse";

export type ManualSaleState = { ok?: string; error?: string } | null;

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** The account's import for hand-added sales, made the first time one's added. */
async function manualImport(orgId: string) {
  const [found] = await db
    .select({ id: schema.imports.id })
    .from(schema.imports)
    .where(and(eq(schema.imports.orgId, orgId), eq(schema.imports.filename, MANUAL_IMPORT)));
  if (found) return found.id;
  const [made] = await db
    .insert(schema.imports)
    .values({ orgId, filename: MANUAL_IMPORT, rowCount: 0, addedCount: 0, duplicateCount: 0 })
    .returning({ id: schema.imports.id });
  return made.id;
}

/** Add a sale by hand (a show, merch sold in person): counted like any other sale, for the band chosen. */
export async function addManualSale(_: ManualSaleState, fd: FormData): Promise<ManualSaleState> {
  const { orgId, access, user } = await requireAccess("sales", "edit");
  const date = str(fd, "date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "Enter the date." };
  const bandId = Number(str(fd, "bandId")) || null;
  if (!bandId) return { error: "Choose the band." };
  const scope = bandScope(access, "sales");
  if (scope && !scope.includes(bandId)) return { error: "That isn’t one of your bands." };
  const [band] = await db.select({ name: schema.bands.name }).from(schema.bands).where(and(eq(schema.bands.orgId, orgId), eq(schema.bands.id, bandId)));
  if (!band) return { error: "Choose the band." };
  const kind = MANUAL_KINDS.find((k) => k.value === str(fd, "kind"));
  if (!kind) return { error: "Choose what it was." };
  const itemName = str(fd, "itemName").slice(0, 200);
  if (!itemName) return { error: "Say what it was." };
  const netCents = parseCents(str(fd, "amount"));
  if (!netCents) return { error: "Enter the amount." };
  const quantity = Math.max(1, Math.round(Number(str(fd, "quantity")) || 1));
  const currency = (str(fd, "currency") || "USD").toUpperCase().slice(0, 3);
  const key = `manual:${randomUUID()}`;
  await db.insert(schema.sales).values({
    orgId,
    importId: await manualImport(orgId),
    dedupeKey: key,
    date,
    itemType: kind.itemType,
    category: kind.category,
    itemName,
    artist: band.name,
    itemUrl: "",
    packageName: "",
    currency,
    netCents,
    quantity,
    transactionId: key,
    routingKey: key,
    bandId,
    routedVia: MANUAL_VIA,
    raw: { source: MANUAL_SOURCE, kind: kind.label, "added by": user.name },
  });
  revalidatePath("/", "layout");
  return { ok: `Added ${itemName}.` };
}

/** Take back a sale that was added by hand, while it isn't part of a payout yet. */
export async function deleteManualSale(_: ManualSaleState, fd: FormData): Promise<ManualSaleState> {
  const { orgId, access } = await requireAccess("sales", "edit");
  const id = Number(str(fd, "id"));
  const [sale] = await db
    .select({ id: schema.sales.id, bandId: schema.sales.bandId, via: schema.sales.routedVia })
    .from(schema.sales)
    .where(and(eq(schema.sales.orgId, orgId), eq(schema.sales.id, id)));
  if (!sale || sale.via !== MANUAL_VIA) return { error: "Only sales added by hand can be deleted." };
  const scope = bandScope(access, "sales");
  if (scope && !(sale.bandId && scope.includes(sale.bandId))) return { error: "That isn’t one of your bands." };
  if (await saleInPayout(orgId, id)) return { error: "It’s part of a payout already, so it stays." };
  await db.delete(schema.sales).where(and(eq(schema.sales.orgId, orgId), eq(schema.sales.id, id)));
  revalidatePath("/", "layout");
  return { ok: "Deleted." };
}
