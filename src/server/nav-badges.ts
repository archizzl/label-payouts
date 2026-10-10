import "server-only";
import { and, count, eq, gt, inArray, sql } from "drizzle-orm";
import { cache } from "react";
import { db, schema } from "@/db";
import { bandScope, can, inBandScope } from "@/lib/permissions";
import type { Context } from "./context";

/*
 * The little numbers on the header's tabs. Orders: waiting to ship, plus pickups not handed over.
 * Sales: new since you last opened Sales. Receipts: waiting for approval (for those who approve).
 * All cheap reads: the order count is saved whenever orders are fetched from Bandcamp.
 */

export type NavBadges = Partial<Record<"orders" | "sales" | "receipts", number>>;

const { accountSettings, pickupOrders, sales, imports, expenses, navSeen } = schema;

export const navBadges = cache(async (ctx: Context): Promise<NavBadges> => {
  const { orgId, access } = ctx;
  const [orders, newSales, pendingReceipts] = await Promise.all([
    can(access, "orders") ? ordersWaiting(orgId, bandScope(access, "orders")) : 0,
    can(access, "sales") ? salesSinceSeen(ctx, bandScope(access, "sales")) : 0,
    can(access, "receipts", "edit") ? db.$count(expenses, and(eq(expenses.orgId, orgId), eq(expenses.status, "pending"))) : 0,
  ]);
  const out: NavBadges = {};
  if (orders) out.orders = orders;
  if (newSales) out.sales = newSales;
  if (pendingReceipts) out.receipts = pendingReceipts;
  return out;
});

async function ordersWaiting(orgId: string, scope: number[] | null) {
  const [[settings], pickups] = await Promise.all([
    db.select({ openOrders: accountSettings.openOrders }).from(accountSettings).where(eq(accountSettings.orgId, orgId)),
    db.select({ bandIds: pickupOrders.bandIds }).from(pickupOrders).where(eq(pickupOrders.orgId, orgId)),
  ]);
  const open = settings?.openOrders;
  const ready = !open ? 0 : scope === null ? open.ready : scope.reduce((a, b) => a + (open.byBand[b] ?? 0), 0);
  return ready + pickups.filter((p) => inBandScope(scope, p.bandIds)).length;
}

async function salesSinceSeen(ctx: Context, scope: number[] | null) {
  const [seen] = await db
    .select({ at: navSeen.seenAt })
    .from(navSeen)
    .where(and(eq(navSeen.orgId, ctx.orgId), eq(navSeen.userId, ctx.user.id), eq(navSeen.area, "sales")));
  // Never opened Sales: nothing counts as new yet (opening it starts the count).
  if (!seen) return 0;
  const [row] = await db
    .select({ n: count() })
    .from(sales)
    .innerJoin(imports, eq(imports.id, sales.importId))
    .where(
      and(
        eq(sales.orgId, ctx.orgId),
        gt(imports.importedAt, seen.at),
        scope ? inArray(sales.bandId, scope.length ? scope : [-1]) : undefined,
      ),
    );
  return row?.n ?? 0;
}

/** They've opened a section: what's new is counted from now. */
export async function markSeen(ctx: Context, area: "sales") {
  await db
    .insert(navSeen)
    .values({ orgId: ctx.orgId, userId: ctx.user.id, area })
    .onConflictDoUpdate({ target: [navSeen.orgId, navSeen.userId, navSeen.area], set: { seenAt: sql`to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')` } });
}
