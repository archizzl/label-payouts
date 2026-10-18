import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { applyMove, type MoveReason } from "@/lib/inventory";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Change an item's count as part of something else (a sale added by hand, or taking one back), the
 * way a change on the Inventory page does: under a lock, never below zero, and kept in its history.
 * Returns how much it actually changed.
 */
export async function takeStock(
  tx: Tx,
  item: { id: number; orgId: string },
  reason: MoveReason,
  amount: number,
  { saleId, userId, note }: { saleId: number | null; userId: string; note: string },
) {
  const [cur] = await tx
    .select({ onHand: schema.inventoryItems.onHand })
    .from(schema.inventoryItems)
    .where(eq(schema.inventoryItems.id, item.id))
    .for("update");
  // (Archived or gone since: nothing to change.)
  if (!cur) return 0;
  const { delta, onHandAfter } = applyMove(cur.onHand, reason, amount);
  if (!delta) return 0;
  await tx.update(schema.inventoryItems).set({ onHand: onHandAfter }).where(eq(schema.inventoryItems.id, item.id));
  await tx.insert(schema.inventoryMoves).values({ orgId: item.orgId, itemId: item.id, delta, reason, note, onHandAfter, byUserId: userId, saleId });
  return delta;
}
