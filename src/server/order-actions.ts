"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import { PICKUP_MESSAGE } from "@/lib/merch-orders";
import { bandScope, inBandScope } from "@/lib/permissions";
import { bandcampCredentials, markMerchShipped } from "./bandcamp-api";
import { getContext, requireAccess } from "./context";
import { markSeen } from "./nav-badges";
import { forgetOpenOrders, loadOpenOrders } from "./merch-orders";
import { readShipmentCosts, recordShipmentCosts } from "./shipment-costs";

export type ShipState = { ok?: string; error?: string } | null;

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/**
 * Mark one order (a Bandcamp payment) shipped, with carrier and tracking shown to the buyer, and
 * email them if asked. Only orders that are open for this account can be marked.
 */
export async function markOrderShipped(_: ShipState, fd: FormData): Promise<ShipState> {
  const { orgId, user, access } = await requireAccess("orders", "edit");
  const creds = await bandcampCredentials(orgId);
  if (!creds) return { error: "Add your Bandcamp API access under Settings first." };
  const paymentId = Number(str(fd, "paymentId"));
  const open = await loadOpenOrders(orgId);
  const order = open.status === "ok" ? open.orders.find((o) => o.paymentId === paymentId) : null;
  if (!order) return { error: "That order isn’t open any more. Refresh to see the latest." };
  const scope = bandScope(access, "orders");
  if (scope && !order.lines.every((l) => l.bandId !== null && scope.includes(l.bandId))) {
    return { error: "This order has items from other bands, so an admin needs to mark it shipped." };
  }
  const notify = fd.get("notify") === "on";
  // Shipping costs, if entered: checked before anything goes to Bandcamp.
  let costs;
  try {
    costs = await readShipmentCosts(orgId, fd, order);
  } catch (e) {
    return { error: (e as Error).message };
  }
  try {
    await markMerchShipped(orgId, creds, [
      {
        paymentId,
        carrier: str(fd, "carrier").slice(0, 60) || undefined,
        trackingCode: str(fd, "tracking").slice(0, 100) || undefined,
        notify,
        message: str(fd, "message").slice(0, 1000) || undefined,
      },
    ]);
  } catch (e) {
    return { error: `Bandcamp didn’t accept it: ${(e as Error).message}` };
  }
  forgetOpenOrders(orgId);
  revalidatePath("/");
  // Shipped on Bandcamp; now the costs.
  let recorded = 0;
  let costError = "";
  if (costs) {
    try {
      recorded = await recordShipmentCosts(orgId, user.id, order, costs, str(fd, "carrier") || null);
      revalidatePath("/receipts");
      revalidatePath("/funds");
    } catch (e) {
      costError = (e as Error).message;
    }
  }
  // The order leaves the list (and its form with it), so say so at the top of the page.
  redirect(
    `/orders?${new URLSearchParams({
      shipped: order.buyer.name || "the buyer",
      ...(notify ? { emailed: "1" } : {}),
      ...(recorded ? { costs: String(recorded), currency: order.currency } : {}),
      ...(costError ? { costError: costError.slice(0, 200) } : {}),
    })}`,
  );
}

/** Fetch the open orders from Bandcamp again now. */
export async function refreshOrders() {
  const { orgId } = await requireAccess("orders");
  forgetOpenOrders(orgId);
  revalidatePath("/orders");
}

/**
 * In-person pickup: mark the order shipped on Bandcamp now (so it isn't late, and the buyer can be
 * told it's ready), and keep it on the Orders page under "Waiting for pickup" until it's handed over.
 */
export async function markOrderPickup(_: ShipState, fd: FormData): Promise<ShipState> {
  const { orgId, user, access } = await requireAccess("orders", "edit");
  const creds = await bandcampCredentials(orgId);
  if (!creds) return { error: "Add your Bandcamp API access under Settings first." };
  const paymentId = Number(str(fd, "paymentId"));
  const open = await loadOpenOrders(orgId);
  const order = open.status === "ok" ? open.orders.find((o) => o.paymentId === paymentId) : null;
  if (!order) return { error: "That order isn’t open any more. Refresh to see the latest." };
  const scope = bandScope(access, "orders");
  if (scope && !order.lines.every((l) => l.bandId !== null && scope.includes(l.bandId))) {
    return { error: "This order has items from other bands, so an admin needs to handle it." };
  }
  const notify = fd.get("notify") === "on";
  try {
    await markMerchShipped(orgId, creds, [
      { paymentId, carrier: "In-person pickup", notify, message: str(fd, "message").slice(0, 1000) || PICKUP_MESSAGE },
    ]);
  } catch (e) {
    return { error: `Bandcamp didn’t accept it: ${(e as Error).message}` };
  }
  forgetOpenOrders(orgId);
  await db
    .insert(schema.pickupOrders)
    .values({
      orgId,
      paymentId,
      buyerName: order.buyer.name || "Buyer",
      orderDate: order.date,
      items: order.lines.map((l) => ({ name: l.name, option: l.option, quantity: l.quantity, sku: l.sku, bandId: l.bandId })),
      bandIds: order.bandIds,
      note: str(fd, "note").slice(0, 500) || null,
      markedByUserId: user.id,
    })
    .onConflictDoNothing();
  revalidatePath("/");
  redirect(`/orders?${new URLSearchParams({ pickup: order.buyer.name || "the buyer", ...(notify ? { emailed: "1" } : {}) })}`);
}

/** Handed over in person: it's done, so its pickup record (the buyer's name, what they got) is deleted. */
export async function markHandedOff(fd: FormData) {
  const { orgId, access } = await requireAccess("orders", "edit");
  const id = Number(str(fd, "id"));
  const [row] = await db
    .select()
    .from(schema.pickupOrders)
    .where(and(eq(schema.pickupOrders.orgId, orgId), eq(schema.pickupOrders.id, id)));
  if (!row || !inBandScope(bandScope(access, "orders"), row.bandIds)) return;
  await db.delete(schema.pickupOrders).where(eq(schema.pickupOrders.id, row.id));
  revalidatePath("/orders");
  revalidatePath("/");
}

/** The note on an order waiting for pickup (where, when, who's collecting). */
export async function savePickupNote(fd: FormData) {
  const { orgId, access } = await requireAccess("orders", "edit");
  const id = Number(str(fd, "id"));
  const [row] = await db
    .select({ bandIds: schema.pickupOrders.bandIds })
    .from(schema.pickupOrders)
    .where(and(eq(schema.pickupOrders.orgId, orgId), eq(schema.pickupOrders.id, id)));
  if (!row || !inBandScope(bandScope(access, "orders"), row.bandIds)) return;
  await db.update(schema.pickupOrders).set({ note: str(fd, "note").slice(0, 500) || null }).where(eq(schema.pickupOrders.id, id));
  revalidatePath("/orders");
}

/** Hide the dashboard's "orders waiting to ship" banner, for a week (for whoever hides it). */
export async function hideOrdersNotice() {
  await markSeen(await getContext(), "orders_notice");
  revalidatePath("/");
}
