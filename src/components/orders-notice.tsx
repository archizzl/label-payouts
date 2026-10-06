import Link from "next/link";
import { readyToShip } from "@/lib/merch-orders";
import { loadOpenOrders } from "@/server/merch-orders";
import { Callout } from "./ui";

/** "3 merch orders waiting to ship" on the dashboard (only when there are some). Streams in after the page. */
export async function OrdersNotice({ orgId }: { orgId: string }) {
  const open = await loadOpenOrders(orgId);
  if (open.status !== "ok") return null;
  const ready = open.orders.filter(readyToShip);
  if (!ready.length) return null;
  const oldest = ready[0].daysWaiting;
  return (
    <Callout tone={oldest > 7 ? "warn" : "neutral"}>
      {ready.length} merch order{ready.length === 1 ? "" : "s"} waiting to ship
      {oldest > 0 && `, the oldest for ${oldest} day${oldest === 1 ? "" : "s"}`}. <Link href="/orders">See orders</Link>
    </Callout>
  );
}
