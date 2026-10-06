import "server-only";
import { eq } from "drizzle-orm";
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
