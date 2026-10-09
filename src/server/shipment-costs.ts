import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { MerchOrder } from "@/lib/merch-orders";
import { parseCents } from "@/lib/money";
import { readReceiptFiles } from "./expenses";
import { discardStoredFiles, storeReceiptFiles } from "./receipt-store";

/*
 * What it cost to send a merch order (postage, packaging), recorded as receipts when it's marked
 * shipped. Read and checked before anything is sent to Bandcamp, saved after.
 */

export type ShipmentCosts = {
  costs: { category: "Shipping" | "Packaging"; amountCents: number }[];
  currency: string;
  paidBy: "label" | "band_fund" | "person";
  paidByPersonId: number | null;
  files: Awaited<ReturnType<typeof readReceiptFiles>>;
};

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** The costs on a "mark shipped" form, or null if none were entered. Throws a readable error if something's off. */
export async function readShipmentCosts(orgId: string, fd: FormData, order: MerchOrder): Promise<ShipmentCosts | null> {
  const postage = parseCents(str(fd, "postage"));
  const packaging = parseCents(str(fd, "packaging"));
  const files = await readReceiptFiles(fd, "receipt");
  if (postage < 0 || packaging < 0) throw new Error("Costs can’t be negative.");
  if (!postage && !packaging) {
    if (files.length) throw new Error("Enter what the postage or packaging cost, to go with the receipt.");
    return null;
  }
  const who = str(fd, "costPaidBy");
  const paidByPersonId = who.startsWith("person:") ? Number(who.slice(7)) || null : null;
  const paidBy = paidByPersonId ? "person" : who === "band_fund" ? "band_fund" : "label";
  if (paidByPersonId) {
    const [p] = await db
      .select({ id: schema.people.id })
      .from(schema.people)
      .where(and(eq(schema.people.orgId, orgId), eq(schema.people.id, paidByPersonId)));
    if (!p) throw new Error("That person isn’t part of this account.");
  }
  if (paidBy === "band_fund" && order.bandIds.length !== 1) throw new Error("This order isn’t for a single band, so a band fund can’t pay for it.");
  return {
    costs: [
      ...(postage ? [{ category: "Shipping" as const, amountCents: postage }] : []),
      ...(packaging ? [{ category: "Packaging" as const, amountCents: packaging }] : []),
    ],
    currency: order.currency,
    paidBy,
    paidByPersonId,
    files,
  };
}

/** Save the costs as approved receipts for the order's band (if it's one band), with the receipt files on the first. */
export async function recordShipmentCosts(orgId: string, userId: string | null, order: MerchOrder, costs: ShipmentCosts, carrier: string | null) {
  const today = new Date().toLocaleDateString("en-CA");
  const what = order.lines.map((l) => `${l.quantity} × ${l.name}${l.option ? ` (${l.option})` : ""}`).join(", ");
  const now = new Date().toISOString();
  const stored = await storeReceiptFiles(orgId, costs.files);
  await db.transaction(async (tx) => {
    for (const [i, c] of costs.costs.entries()) {
      const [{ id }] = await tx
        .insert(schema.expenses)
        .values({
          orgId,
          date: today,
          description: `${c.category === "Shipping" ? "Postage" : "Packaging"} for ${order.buyer.name || "a merch order"}: ${what}`.slice(0, 300),
          vendor: c.category === "Shipping" ? carrier : null,
          category: c.category,
          amountCents: c.amountCents,
          currency: costs.currency,
          bandId: order.bandIds.length === 1 ? order.bandIds[0] : null,
          paidBy: costs.paidBy,
          paidByPersonId: costs.paidByPersonId,
          recoup: false,
          status: "approved",
          reviewedAt: now,
          submittedByUserId: userId,
        })
        .returning({ id: schema.expenses.id });
      if (i === 0 && stored.length) await tx.insert(schema.expenseFiles).values(stored.map((f) => ({ ...f, orgId, expenseId: id })));
    }
  }).catch(async (e) => {
    await discardStoredFiles(stored);
    throw e;
  });
  return costs.costs.reduce((a, c) => a + c.amountCents, 0);
}
