import { describe, expect, it } from "vitest";
import { groupOrders, pickList, readyToShip, type RawOrderItem } from "../merch-orders";

const item = (over: Partial<RawOrderItem>): RawOrderItem => ({
  sale_item_id: 1,
  payment_id: 100,
  order_date: "02 Oct 2026 18:00:00 GMT",
  item_name: "Flags of the World",
  artist: "Flag Day",
  option: null,
  quantity: 1,
  currency: "USD",
  buyer_name: "Ann Lee",
  ship_to_name: "Ann Lee",
  ship_to_street: "1 Main St",
  ship_to_city: "Brooklyn",
  ship_to_state: "NY",
  ship_to_zip: "11211",
  ship_to_country: "United States",
  payment_state: "paid",
  ...over,
});
const bands = [{ id: 7, name: "Flag Day", aliases: [] }, { id: 6, name: "Sweetums", aliases: ["The Sweetums"] }];

describe("open merch orders", () => {
  it("groups items into orders, oldest first, with addresses ready to print", () => {
    const orders = groupOrders(
      [
        item({ sale_item_id: 1, payment_id: 100, quantity: 2 }),
        item({ sale_item_id: 2, payment_id: 100, item_name: "Shirt", option: "M", artist: "The Sweetums", buyer_note: "gift!" }),
        item({ sale_item_id: 3, payment_id: 99, order_date: "28 Sep 2026 10:00:00 GMT", buyer_name: "Bo", ship_to_name: "Bo", ship_to_street_2: "Apt 4" }),
      ],
      bands,
      "2026-10-06",
    );
    expect(orders.map((o) => [o.paymentId, o.date, o.daysWaiting])).toEqual([
      [99, "2026-09-28", 8],
      [100, "2026-10-02", 4],
    ]);
    expect(orders[1].lines.map((l) => [l.quantity, l.name, l.option, l.bandId])).toEqual([
      [2, "Flags of the World", null, 7],
      [1, "Shirt", "M", 6],
    ]);
    expect(orders[1].note).toBe("gift!");
    expect(orders[1].bandIds.sort()).toEqual([6, 7]);
    expect(orders[0].address).toEqual(["Bo", "1 Main St", "Apt 4", "Brooklyn, NY 11211", "United States"]);
  });

  it("holds back pre-orders that aren't out yet and failed payments", () => {
    const [failed, preorder, ready] = groupOrders(
      [
        item({ sale_item_id: 1, payment_id: 1, payment_state: "failed", order_date: "01 Oct 2026 10:00:00 GMT" }),
        item({ sale_item_id: 2, payment_id: 2, begins_shipping_on: "2026-11-01", order_date: "02 Oct 2026 10:00:00 GMT" }),
        item({ sale_item_id: 3, payment_id: 3, begins_shipping_on: "2026-09-01", order_date: "03 Oct 2026 10:00:00 GMT" }),
      ],
      bands,
      "2026-10-06",
    );
    expect([failed.failed, preorder.preorderUntil, ready.preorderUntil]).toEqual([true, "2026-11-01", null]);
    expect([failed, preorder, ready].map(readyToShip)).toEqual([false, false, true]);
  });

  it("adds up what to pack by item and option", () => {
    const orders = groupOrders(
      [
        item({ sale_item_id: 1, payment_id: 1, quantity: 2 }),
        item({ sale_item_id: 2, payment_id: 2 }),
        item({ sale_item_id: 3, payment_id: 2, item_name: "Shirt", option: "M" }),
        item({ sale_item_id: 4, payment_id: 3, item_name: "Shirt", option: "L" }),
      ],
      bands,
      "2026-10-06",
    );
    expect(pickList(orders).map((p) => [p.name, p.option, p.quantity, p.orders])).toEqual([
      ["Flags of the World", null, 3, 2],
      ["Shirt", "L", 1, 1],
      ["Shirt", "M", 1, 1],
    ]);
  });
});
