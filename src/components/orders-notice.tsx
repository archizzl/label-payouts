import Link from "next/link";
import { readyToShip } from "@/lib/merch-orders";
import type { Context } from "@/server/context";
import { loadOpenOrders } from "@/server/merch-orders";
import { hiddenWithin } from "@/server/nav-badges";
import { hideOrdersNotice } from "@/server/order-actions";
import { Callout } from "./ui";

/** Hidden for this long; after that it comes back if orders are still waiting. */
const HIDE_DAYS = 7;

/**
 * "3 merch orders waiting to ship" on the dashboard (only when there are some). Streams in after
 * the page. Anyone can hide it for a week.
 */
export async function OrdersNotice({ ctx }: { ctx: Context }) {
  if (await hiddenWithin(ctx, "orders_notice", HIDE_DAYS)) return null;
  const open = await loadOpenOrders(ctx.orgId);
  if (open.status !== "ok") return null;
  const ready = open.orders.filter(readyToShip);
  if (!ready.length) return null;
  const oldest = ready[0].daysWaiting;
  return (
    <Callout tone={oldest > 7 ? "warn" : "neutral"}>
      <div className="flex items-start gap-3">
        <span className="flex-1">
          {ready.length} merch order{ready.length === 1 ? "" : "s"} waiting to ship
          {oldest > 0 && `, the oldest for ${oldest} day${oldest === 1 ? "" : "s"}`}. <Link href="/orders">See orders</Link>
        </span>
        {!ctx.viewingAs && (
          <form action={hideOrdersNotice}>
            <button
              type="submit"
              aria-label="Hide this for a week"
              className="-my-0.5 flex h-6 w-6 items-center justify-center rounded-sm text-lg leading-none opacity-70 hover:opacity-100"
            >
              ×
            </button>
          </form>
        )}
      </div>
    </Callout>
  );
}
