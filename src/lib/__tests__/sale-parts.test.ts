import { describe, expect, it } from "vitest";
import { salePartsOf } from "../sale-parts";

describe("parts of a sale", () => {
  it("reads what the fan paid above the price, as positive cents", () => {
    expect(salePartsOf({ "additional fan contribution": "(2.00)" })).toEqual({ fan_extra: 200 });
    expect(salePartsOf({})).toEqual({ fan_extra: 0 });
  });

  it("never offers shipping or tax: they aren't in the net amount that gets split", () => {
    // A withholding left over from before takes nothing.
    expect(salePartsOf({ shipping: "4.50", "seller tax": "1" })).toEqual({ fan_extra: 0 });
  });
});
