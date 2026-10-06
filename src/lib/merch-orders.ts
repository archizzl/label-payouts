import { parseBandcampDate } from "./bandcamp-csv";
import { normalizeText } from "./routing";

/*
 * Open merch orders, from the rows Bandcamp's Merch Orders API returns (one per item): grouped into
 * orders, with what to pack. Plain data; buyers' details are only ever shown, never stored.
 */

export type RawOrderItem = {
  sale_item_id: number;
  payment_id: number;
  order_date: string;
  item_name?: string;
  item_url?: string;
  artist?: string;
  option?: string | null;
  sku?: string | null;
  quantity?: number;
  order_total?: number;
  currency?: string;
  buyer_name?: string;
  buyer_email?: string;
  buyer_phone?: string;
  buyer_note?: string | null;
  ship_notes?: string | null;
  ship_to_name?: string;
  ship_to_street?: string;
  ship_to_street_2?: string;
  ship_to_city?: string;
  ship_to_state?: string;
  ship_to_zip?: string;
  ship_to_country?: string;
  ship_to_phone?: string;
  begins_shipping_on?: string | null;
  payment_state?: string;
};

export type OrderLine = { saleItemId: number; name: string; option: string | null; quantity: number; sku: string | null; artist: string; bandId: number | null };

export type MerchOrder = {
  paymentId: number;
  date: string; // yyyy-mm-dd
  daysWaiting: number;
  buyer: { name: string; email: string | null; phone: string | null };
  note: string | null;
  address: string[]; // lines, ready to print
  country: string;
  lines: OrderLine[];
  total: number | null;
  currency: string;
  /** A pre-order that can't ship yet: the date it can. */
  preorderUntil: string | null;
  /** Payment didn't go through (e.g. a failed PayPal eCheck): don't ship. */
  failed: boolean;
  bandIds: number[];
};

const clean = (s: string | null | undefined) => (s ?? "").trim();

/** Group item rows into orders (oldest first), matching each item's artist to a band. */
export function groupOrders(items: RawOrderItem[], bands: { id: number; name: string; aliases: string[] }[], today: string): MerchOrder[] {
  const bandFor = (artist: string) => {
    const a = normalizeText(artist);
    return bands.find((b) => [b.name, ...b.aliases].some((n) => normalizeText(n) === a))?.id ?? null;
  };
  const byPayment = new Map<number, RawOrderItem[]>();
  for (const it of items) byPayment.set(it.payment_id, [...(byPayment.get(it.payment_id) ?? []), it]);

  const days = (from: string) => Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));
  const orders = [...byPayment].map(([paymentId, rows]): MerchOrder => {
    const first = rows[0];
    const date = parseBandcampDate(first.order_date) ?? today;
    const begins = rows.map((r) => (r.begins_shipping_on ? parseBandcampDate(r.begins_shipping_on) : null)).filter((d): d is string => !!d && d > today);
    const lines = rows.map((r) => ({
      saleItemId: r.sale_item_id,
      name: clean(r.item_name) || "Item",
      option: clean(r.option) || null,
      quantity: Math.max(1, r.quantity ?? 1),
      sku: clean(r.sku) || null,
      artist: clean(r.artist),
      bandId: bandFor(clean(r.artist)),
    }));
    const cityLine = [clean(first.ship_to_city), [clean(first.ship_to_state), clean(first.ship_to_zip)].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    return {
      paymentId,
      date,
      daysWaiting: days(date),
      buyer: { name: clean(first.buyer_name) || clean(first.ship_to_name), email: clean(first.buyer_email) || null, phone: clean(first.buyer_phone) || clean(first.ship_to_phone) || null },
      // Notes can be on any item of the order; each one once.
      note: [...new Set(rows.flatMap((r) => [clean(r.buyer_note), clean(r.ship_notes)]).filter(Boolean))].join(" · ") || null,
      address: [clean(first.ship_to_name), clean(first.ship_to_street), clean(first.ship_to_street_2), cityLine, clean(first.ship_to_country)].filter(Boolean),
      country: clean(first.ship_to_country),
      lines,
      total: first.order_total ?? null,
      currency: clean(first.currency) || "USD",
      preorderUntil: begins.length ? begins.sort().at(-1)! : null,
      failed: rows.some((r) => r.payment_state === "failed"),
      bandIds: [...new Set(lines.map((l) => l.bandId).filter((b): b is number => b !== null))],
    };
  });
  return orders.sort((a, b) => a.date.localeCompare(b.date) || a.paymentId - b.paymentId);
}

/** Ready to ship now: paid, and not a pre-order that hasn't come out yet. */
export const readyToShip = (o: MerchOrder) => !o.failed && !o.preorderUntil;

/** What to pack across these orders: each item and option, and how many, most first. */
export function pickList(orders: MerchOrder[]) {
  const totals = new Map<string, { name: string; option: string | null; sku: string | null; quantity: number; orders: number }>();
  for (const o of orders) {
    for (const l of o.lines) {
      const key = `${l.name}\u0000${l.option ?? ""}`;
      const t = totals.get(key) ?? { name: l.name, option: l.option, sku: l.sku, quantity: 0, orders: 0 };
      t.quantity += l.quantity;
      t.orders += 1;
      totals.set(key, t);
    }
  }
  return [...totals.values()].sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name) || (a.option ?? "").localeCompare(b.option ?? ""));
}
