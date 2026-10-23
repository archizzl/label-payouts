import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { formatCents, parseCents } from "@/lib/money";
import { MOVE_REASONS } from "@/lib/inventory";
import { MANUAL_KINDS } from "@/lib/manual-sales";
import { addManualSale } from "../manual-sale-actions";
import { finalizePayout, markAllPaid } from "../actions";
import { adjustInventory } from "../inventory-actions";
import { markOrderShipped } from "../order-actions";
import { saleAdder } from "../manual-sales";
import type { Context } from "../context";
import { nameMaps } from "../data";
import { abelTool, form, viaAction } from "./tool";
import { CATALOG_TOOLS } from "./actions/catalog";
import { MONEY_TOOLS } from "./actions/money";
import { RECEIPT_TOOLS } from "./actions/receipts";
import { ROSTER_TOOLS } from "./actions/roster";
import { RULES_TOOLS } from "./actions/rules";
import { SALES_TOOLS } from "./actions/sales";
import { SETTINGS_TOOLS } from "./actions/settings";
import { STOCK_TOOLS } from "./actions/stock";

/*
 * Changes Abel can make: every action the app has that can be done without a file upload or a
 * password, each available only to those whose access allows it. Each asks the person to confirm
 * first (the confirm card shows `summary`), then runs the app's own server action, which checks
 * their access again. The first few are here; the rest are in actions/, by area.
 */

const bandName = async (ctx: Context, id: number) => (await nameMaps(ctx.orgId)).band.get(id) ?? `band #${id}`;

async function payoutName(ctx: Context, id: number) {
  const [p] = await db
    .select({ name: schema.periods.name })
    .from(schema.periods)
    .where(and(eq(schema.periods.orgId, ctx.orgId), eq(schema.periods.id, id)));
  return p ? `“${p.name}”` : `payout #${id}`;
}

async function itemName(ctx: Context, id: number) {
  const [i] = await db
    .select({ name: schema.inventoryItems.name, option: schema.inventoryItems.option })
    .from(schema.inventoryItems)
    .where(and(eq(schema.inventoryItems.orgId, ctx.orgId), eq(schema.inventoryItems.id, id)));
  return i ? `${i.name}${i.option ? ` (${i.option})` : ""}` : `item #${id}`;
}

const money = (amount: string, currency = "USD") => formatCents(parseCents(amount), currency.toUpperCase());

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");
const amount = z.string().regex(/^-?\d+(\.\d{1,2})?$/, "an amount like 12.50");

const addSale = abelTool({
  name: "add_manual_sale",
  description:
    "Add a sale by hand for one of the person's bands: money from a show, or anything else sold in person. (For merch from the catalog, send them to /sales/add.)",
  params: z.object({
    bandId: z.number().int(),
    date,
    kind: z.enum(MANUAL_KINDS.filter((k) => k.value !== "merch").map((k) => k.value) as ["show", "other"]),
    what: z.string().min(1).max(200).describe("What it was, e.g. the venue and date of the show"),
    amount,
    currency: z.string().length(3).optional(),
    quantity: z.number().int().min(1).optional(),
  }),
  needs: "anyone",
  write: true,
  summary: async (ctx, a) => `Add a sale for ${await bandName(ctx, a.bandId)}: ${a.what}, ${money(a.amount, a.currency)}, on ${a.date}`,
  run: async (_ctx, a) => {
    // Who may add sales, and for which bands, is the action's own rule (saleAdder).
    if (!(await saleAdder())) return { error: "Only a band's members can add its sales." };
    return viaAction(() =>
      addManualSale(null, form({ bandId: a.bandId, date: a.date, kind: a.kind, itemName: a.what, amount: a.amount, currency: a.currency, quantity: a.quantity })),
    );
  },
});

const createPayout = abelTool({
  name: "create_payout",
  description:
    "Finalize a payout: lock in what each person is owed for sales in these dates, for one band or the whole group. Check what it would pay first with owed_by_band. Sales that can't be paid to anyone yet are left for a later payout only if payTheRest is true.",
  params: z.object({
    from: date,
    to: date,
    bandId: z.number().int().optional(),
    name: z.string().max(120).optional(),
    payTheRest: z.boolean().optional(),
  }),
  needs: { area: "payouts", level: "edit" },
  write: true,
  summary: async (ctx, a) =>
    `Finalize a payout${a.name ? ` called “${a.name}”` : ""} for ${a.bandId ? await bandName(ctx, a.bandId) : "the whole group"}, sales from ${a.from} to ${a.to}${a.payTheRest ? ", leaving sales that can’t be paid yet for later" : ""}`,
  run: async (_ctx, a) =>
    viaAction(() => finalizePayout(null, form({ startDate: a.from, endDate: a.to, bandId: a.bandId, name: a.name, force: a.payTheRest })), "Payout finalized."),
});

const markPaid = abelTool({
  name: "mark_payout_paid",
  description: "Mark everyone still to be paid in a finalized payout as paid.",
  params: z.object({ payoutId: z.number().int(), reference: z.string().max(120).optional() }),
  needs: { area: "payouts", level: "edit" },
  write: true,
  summary: async (ctx, a) => `Mark everyone still to be paid in ${await payoutName(ctx, a.payoutId)} as paid${a.reference ? ` (reference ${a.reference})` : ""}`,
  run: async (_ctx, a) =>
    viaAction(async () => {
      await markAllPaid(form({ periodId: a.payoutId, reference: a.reference }));
    }, "Marked paid."),
});

const shipOrder = abelTool({
  name: "mark_order_shipped",
  description: "Mark an open merch order shipped on Bandcamp, with the carrier and tracking code if given. The buyer is emailed only if notifyBuyer is true.",
  params: z.object({
    orderId: z.number().int(),
    carrier: z.string().max(60).optional(),
    tracking: z.string().max(100).optional(),
    notifyBuyer: z.boolean().optional(),
  }),
  needs: { area: "orders", level: "edit" },
  write: true,
  summary: (_ctx, a) =>
    `Mark order ${a.orderId} shipped${a.carrier ? ` with ${a.carrier}` : ""}${a.tracking ? `, tracking ${a.tracking}` : ""}${a.notifyBuyer ? ", and email the buyer" : ""}`,
  run: async (_ctx, a) =>
    viaAction(
      () => markOrderShipped(null, form({ paymentId: a.orderId, carrier: a.carrier, tracking: a.tracking, notify: a.notifyBuyer })),
      "Marked shipped.",
    ),
});

const changeStock = abelTool({
  name: "adjust_inventory",
  description: "Change an inventory item's count: received, sold, used, given, damaged, or a recount (sets the count). Use inventory for ids.",
  params: z.object({
    itemId: z.number().int(),
    reason: z.enum(MOVE_REASONS.map((r) => r.key) as [string, ...string[]]),
    amount: z.number().int(),
    note: z.string().max(300).optional(),
  }),
  needs: { area: "inventory", level: "edit", bandMay: true },
  write: true,
  summary: async (ctx, a) => {
    const item = await itemName(ctx, a.itemId);
    const reason = MOVE_REASONS.find((r) => r.key === a.reason)!.label.toLowerCase();
    return a.reason === "recount" ? `Set the count of ${item} to ${a.amount}` : `${item}: ${reason}, ${Math.abs(a.amount)}`;
  },
  run: async (_ctx, a) => viaAction(() => adjustInventory(null, form({ id: a.itemId, reason: a.reason, amount: a.amount, note: a.note }))),
});

export const WRITE_TOOLS = [
  addSale,
  createPayout,
  markPaid,
  shipOrder,
  changeStock,
  ...RULES_TOOLS,
  ...MONEY_TOOLS,
  ...SALES_TOOLS,
  ...ROSTER_TOOLS,
  ...CATALOG_TOOLS,
  ...STOCK_TOOLS,
  ...RECEIPT_TOOLS,
  ...SETTINGS_TOOLS,
];
