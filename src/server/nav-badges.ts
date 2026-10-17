import "server-only";
import { and, count, eq, gt, inArray, sql } from "drizzle-orm";
import { cache } from "react";
import { db, schema } from "@/db";
import { bandScope, can, inBandScope } from "@/lib/permissions";
import { type Context, ownBooksOf } from "./context";

/*
 * The little numbers on the header's tabs. Orders: waiting to ship, plus pickups not handed over.
 * Sales: new since you last opened Sales. Receipts: waiting for approval (for those who approve).
 * All cheap reads: the order count is saved whenever orders are fetched from Bandcamp.
 */

export type NavBadges = Partial<Record<"orders" | "sales" | "receipts", number>>;

const { accountSettings, pickupOrders, sales, imports, expenses, navSeen } = schema;

export const navBadges = cache(async (ctx: Context): Promise<NavBadges> => {
  const { orgId, access } = ctx;
  // A band account the label made: its sales and receipts are its own books' (its orders the label's).
  const books = ctx.lens ? await ownBooksOf(ctx) : ctx;
  const [orders, newSales, pendingReceipts] = await Promise.all([
    can(access, "orders") ? ordersWaiting(orgId, bandScope(access, "orders")) : 0,
    can(books.access, "sales") ? salesSinceSeen(books, bandScope(books.access, "sales")) : 0,
    can(books.access, "receipts", "edit") ? db.$count(expenses, and(eq(expenses.orgId, books.orgId), eq(expenses.status, "pending"))) : 0,
  ]);
  const out: NavBadges = {};
  if (orders) out.orders = orders;
  if (newSales) out.sales = newSales;
  if (pendingReceipts) out.receipts = pendingReceipts;
  return out;
});

/**
 * Whether the account has orders to show: Bandcamp API access (where merch orders come from), or
 * in-person pickups. Without either the Orders tab only says how to connect, so it's left out.
 */
export const ordersInUse = cache(async (orgId: string) => {
  const [[settings], pickups] = await Promise.all([
    db
      .select({ id: accountSettings.bandcampClientId, secret: accountSettings.bandcampClientSecret, openOrders: accountSettings.openOrders })
      .from(accountSettings)
      .where(eq(accountSettings.orgId, orgId)),
    db.select({ bandIds: pickupOrders.bandIds }).from(pickupOrders).where(eq(pickupOrders.orgId, orgId)),
  ]);
  return { api: !!(settings?.id && settings.secret), openOrders: settings?.openOrders ?? null, pickups, inUse: !!(settings?.id && settings.secret) || pickups.length > 0 };
});

async function ordersWaiting(orgId: string, scope: number[] | null) {
  const { api, openOrders, pickups } = await ordersInUse(orgId);
  // The saved count is from the last fetch; without API access it's out of date, so it doesn't count.
  const open = api ? openOrders : null;
  const ready = !open ? 0 : scope === null ? open.ready : scope.reduce((a, b) => a + (open.byBand[b] ?? 0), 0);
  return ready + pickups.filter((p) => inBandScope(scope, p.bandIds)).length;
}

/** Whether they hid something ("orders_notice": the dashboard's orders banner) within the last `days`. */
export async function hiddenWithin(ctx: Context, area: "orders_notice", days: number): Promise<boolean> {
  const [row] = await db
    .select({ id: navSeen.id })
    .from(navSeen)
    .where(
      and(
        eq(navSeen.orgId, ctx.orgId),
        eq(navSeen.userId, ctx.user.id),
        eq(navSeen.area, area),
        // seen_at is UTC text, "YYYY-MM-DD HH24:MI:SS", so it compares as a string.
        gt(navSeen.seenAt, sql`to_char(now() at time zone 'utc' - make_interval(days => ${days}), 'YYYY-MM-DD HH24:MI:SS')`),
      ),
    );
  return !!row;
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
export async function markSeen(ctx: Context, area: "sales" | "orders_notice") {
  // Looking as someone else doesn't count as them having looked.
  if (ctx.viewingAs) return;
  await db
    .insert(navSeen)
    .values({ orgId: ctx.orgId, userId: ctx.user.id, area })
    .onConflictDoUpdate({ target: [navSeen.orgId, navSeen.userId, navSeen.area], set: { seenAt: sql`to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')` } });
}
