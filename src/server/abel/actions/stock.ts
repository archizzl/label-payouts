import "server-only";
import { z } from "zod";
import { schema } from "@/db";
import { addFromCatalog, archiveInventoryItem, saveInventoryItem } from "../../inventory-actions";
import { markHandedOff, markOrderPickup, savePickupNote } from "../../order-actions";
import { actionTool } from "../tool";
import { amount, current, currency, id, or, toAmount } from "./shared";

/* Orders (besides marking one shipped: write-tools.ts) and inventory (besides counts: write-tools.ts). */

const pickup = actionTool({
  name: "mark_order_for_pickup",
  label: "Mark an order for pickup in person",
  description:
    "Mark an open merch order as collected in person instead of shipped: it's marked shipped on Bandcamp and waits on the pickup list until it's handed over. The buyer is emailed the message only if notifyBuyer is true.",
  params: z.object({ orderId: id, message: z.string().max(1000).optional(), note: z.string().max(500).optional(), notifyBuyer: z.boolean().optional() }),
  needs: { area: "orders", level: "edit" },
  action: (fd) => markOrderPickup(null, fd),
  fields: (_ctx, a) => ({ paymentId: a.orderId, message: a.message, note: a.note, notify: a.notifyBuyer }),
  done: "Marked for pickup.",
});

const handedOff = actionTool({
  name: "mark_handed_over",
  label: "Mark a pickup handed over",
  description: "An order waiting for pickup has been handed over (pickup_orders lists them): it comes off the list.",
  params: z.object({ pickupId: id }),
  needs: { area: "orders", level: "edit" },
  items: { pickupId: "pickup" },
  action: (fd) => markHandedOff(fd),
  fields: (_ctx, a) => ({ id: a.pickupId }),
});

const pickupNote = actionTool({
  name: "save_pickup_note",
  label: "Change a pickup's note",
  description: "The note on an order waiting for pickup: where, when, who's collecting.",
  params: z.object({ pickupId: id, note: z.string().max(500) }),
  needs: { area: "orders", level: "edit" },
  items: { pickupId: "pickup" },
  action: (fd) => savePickupNote(fd),
  fields: (_ctx, a) => ({ id: a.pickupId, note: a.note }),
});

const saveItem = actionTool({
  name: "save_inventory_item",
  label: "Save an inventory item",
  description:
    "Add an item to inventory, or change one (give its id; only the fields given change; counts change with adjust_inventory). kind: product (sold) or supply (used up). A release and its format (packageId) tie it to the catalog. onHand: the starting count of a new item. lowAt: warn below this count.",
  params: z.object({
    id: id.optional(),
    name: z.string().min(1).max(200).optional(),
    kind: z.enum(["product", "supply"]).optional(),
    bandId: id.optional().describe("The band it's for (a band's id, not a person's)"),
    releaseId: id.optional(),
    packageId: id.optional(),
    option: z.string().max(100).optional().describe("Like a size"),
    sku: z.string().max(100).optional(),
    lowAt: z.number().int().min(0).optional(),
    unitCost: amount.optional(),
    price: amount.optional(),
    currency: currency.optional(),
    location: z.string().max(200).optional(),
    notes: z.string().max(1000).optional(),
    onHand: z.number().int().min(0).optional(),
  }),
  needs: { area: "inventory", level: "edit" },
  items: { id: "inventory item" },
  action: (fd) => saveInventoryItem(null, fd),
  fields: async (ctx, a) => {
    const i = a.id ? await current(schema.inventoryItems, ctx.orgId, a.id, "inventory item") : null;
    const releaseId = or(a.releaseId, i?.releaseId ?? undefined);
    const packageId = or(a.packageId, i?.packageId ?? undefined);
    return {
      id: a.id,
      name: or(a.name, i?.name),
      kind: or(a.kind, i?.kind ?? "product"),
      bandId: or(a.bandId, i?.bandId ?? undefined),
      catalog: releaseId ? `${releaseId}${packageId ? `:${packageId}` : ""}` : undefined,
      option: or(a.option, i?.option ?? undefined),
      sku: or(a.sku, i?.sku ?? undefined),
      lowAt: or(a.lowAt, i?.lowAt ?? undefined),
      unitCost: or(a.unitCost, toAmount(i?.unitCostCents)),
      price: or(a.price, toAmount(i?.priceCents)),
      currency: or(a.currency, i?.currency),
      location: or(a.location, i?.location ?? undefined),
      notes: or(a.notes, i?.notes ?? undefined),
      onHand: a.id ? undefined : a.onHand,
    };
  },
});

const archiveItem = actionTool({
  name: "archive_inventory_item",
  label: "Take an item off the inventory list",
  description: "Take an item off the inventory list (its history is kept).",
  params: z.object({ itemId: id }),
  needs: { area: "inventory", level: "edit" },
  items: { itemId: "inventory item" },
  action: (fd) => archiveInventoryItem(fd),
  fields: (_ctx, a) => ({ id: a.itemId }),
});

const fromCatalog = actionTool({
  name: "add_inventory_from_catalog",
  label: "Add the catalog's merch to inventory",
  description: "Add every format and merch item from the catalog that isn't in inventory yet (counts start at 0), for one band or all.",
  params: z.object({ bandId: id.optional() }),
  needs: { area: "inventory", level: "edit" },
  action: (fd) => addFromCatalog(null, fd),
});

export const STOCK_TOOLS = [pickup, handedOff, pickupNote, saveItem, archiveItem, fromCatalog];
