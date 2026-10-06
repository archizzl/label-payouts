"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { bandcampCredentials, markMerchShipped } from "./bandcamp-api";
import { requireAdmin } from "./context";
import { forgetOpenOrders, loadOpenOrders } from "./merch-orders";

export type ShipState = { ok?: string; error?: string } | null;

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/**
 * Mark one order (a Bandcamp payment) shipped, with carrier and tracking shown to the buyer, and
 * email them if asked. Only orders that are open for this account can be marked.
 */
export async function markOrderShipped(_: ShipState, fd: FormData): Promise<ShipState> {
  const { orgId } = await requireAdmin();
  const creds = await bandcampCredentials(orgId);
  if (!creds) return { error: "Add your Bandcamp API access under Settings first." };
  const paymentId = Number(str(fd, "paymentId"));
  const open = await loadOpenOrders(orgId);
  const order = open.status === "ok" ? open.orders.find((o) => o.paymentId === paymentId) : null;
  if (!order) return { error: "That order isn’t open any more. Refresh to see the latest." };
  const notify = fd.get("notify") === "on";
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
  // The order leaves the list (and its form with it), so say so at the top of the page.
  redirect(`/orders?${new URLSearchParams({ shipped: order.buyer.name || "the buyer", ...(notify ? { emailed: "1" } : {}) })}`);
}

/** Fetch the open orders from Bandcamp again now. */
export async function refreshOrders() {
  const { orgId } = await requireAdmin();
  forgetOpenOrders(orgId);
  revalidatePath("/orders");
}
