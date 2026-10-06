import { describe, expect, it } from "vitest";
import { salePartsOf } from "../sale-parts";

describe("parts of a sale", () => {
  it("reads shipping, paid-above-price and seller tax from the report, as positive cents", () => {
    expect(salePartsOf({ shipping: "4.50", "additional fan contribution": "2", "seller tax": "(0.80)" })).toEqual({
      shipping: 450,
      fan_extra: 200,
      seller_tax: 80,
    });
    expect(salePartsOf({})).toEqual({ shipping: 0, fan_extra: 0, seller_tax: 0 });
  });
});
