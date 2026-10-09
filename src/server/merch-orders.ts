import "server-only";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { groupOrders, type MerchOrder } from "@/lib/merch-orders";
import { bandcampCredentials, openMerchOrders } from "./bandcamp-api";

/*
 * Open merch orders, fetched live from Bandcamp (never stored: they hold buyers' addresses). Kept
 * for a couple of minutes in memory so the dashboard's count doesn't ask Bandcamp on every visit.
 */

export type OpenOrders = { status: "ok"; orders: MerchOrder[]; fetchedAt: number } | { status: "no-api" } | { status: "error"; message: string };

const CACHE_MS = 2 * 60 * 1000;
const cache = ((globalThis as unknown as { merchOrders?: Map<string, { at: number; value: OpenOrders }> }).merchOrders ??= new Map());

export function forgetOpenOrders(orgId: string) {
  cache.delete(orgId);
}

export async function loadOpenOrders(orgId: string, { fresh = false } = {}): Promise<OpenOrders> {
  const hit = cache.get(orgId);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const creds = await bandcampCredentials(orgId);
  if (!creds) return { status: "no-api" };
  let value: OpenOrders;
  try {
    const [items, bands] = await Promise.all([
      openMerchOrders(orgId, creds),
      db.select({ id: schema.bands.id, name: schema.bands.name, aliases: schema.bands.aliases }).from(schema.bands).where(eq(schema.bands.orgId, orgId)),
    ]);
    value = { status: "ok", orders: groupOrders(items, bands, new Date().toLocaleDateString("en-CA")), fetchedAt: Date.now() };
  } catch (e) {
    value = { status: "error", message: (e as Error).message };
  }
  if (value.status === "ok") cache.set(orgId, { at: Date.now(), value });
  return value;
}

/** A sale behind an order's item, as Bandcamp reported it in the sales report. */
export type OrderSale = {
  saleId: number;
  saleItemId: number | null;
  itemName: string;
  packageName: string;
  quantity: number;
  currency: string;
  netCents: number;
  raw: Record<string, string>;
};

/**
 * The sales behind these orders (once the hourly sales sync has brought them in), by payment id.
 * An order's payment is Bandcamp's transaction; each item, a transaction item.
 */
export async function salesForOrders(orgId: string, orders: MerchOrder[]): Promise<Map<number, OrderSale[]>> {
  const out = new Map<number, OrderSale[]>();
  if (!orders.length) return out;
  const paymentIds = orders.map((o) => String(o.paymentId));
  const itemIds = orders.flatMap((o) => o.lines.map((l) => String(l.saleItemId)));
  const itemId = sql<string>`${schema.sales.raw}->>'bandcamp transaction item id'`;
  const rows = await db
    .select({
      saleId: schema.sales.id,
      transactionId: schema.sales.transactionId,
      itemId,
      itemName: schema.sales.itemName,
      packageName: schema.sales.packageName,
      quantity: schema.sales.quantity,
      currency: schema.sales.currency,
      netCents: schema.sales.netCents,
      raw: schema.sales.raw,
    })
    .from(schema.sales)
    .where(and(eq(schema.sales.orgId, orgId), or(inArray(schema.sales.transactionId, paymentIds), inArray(itemId, itemIds))));
  for (const o of orders) {
    const items = new Set(o.lines.map((l) => String(l.saleItemId)));
    const mine = rows.filter((r) => r.transactionId === String(o.paymentId) || (r.itemId && items.has(r.itemId)));
    if (mine.length) {
      out.set(
        o.paymentId,
        mine.map((r) => ({
          saleId: r.saleId,
          saleItemId: r.itemId ? Number(r.itemId) : null,
          itemName: r.itemName,
          packageName: r.packageName,
          quantity: r.quantity,
          currency: r.currency,
          netCents: r.netCents,
          raw: r.raw,
        })),
      );
    }
  }
  return out;
}
