import { describe, expect, it } from "vitest";
import { archiveNames, batchFiles, isSettled } from "../receipt-cleanup";

const e = (o: Partial<Parameters<typeof isSettled>[0]> = {}) =>
  ({ status: "approved", paidBy: "label", recoup: false, reimbursedAt: null, amountCents: 1000, ...o }) as Parameters<typeof isSettled>[0];

describe("which receipts are settled", () => {
  it("needs approval", () => {
    expect(isSettled(e({ status: "pending" }))).toBe(false);
    expect(isSettled(e({ status: "rejected" }))).toBe(false);
  });
  it("paid by the label or a band fund, not paid back from sales: nothing owed", () => {
    expect(isSettled(e())).toBe(true);
    expect(isSettled(e({ paidBy: "band_fund" }))).toBe(true);
  });
  it("someone fronted it: once they've been paid back", () => {
    expect(isSettled(e({ paidBy: "person" }))).toBe(false);
    expect(isSettled(e({ paidBy: "person", reimbursedAt: "2026-10-01" }))).toBe(true);
  });
  it("paid back from sales: once sales have covered all of it", () => {
    expect(isSettled(e({ recoup: true }), 999)).toBe(false);
    expect(isSettled(e({ recoup: true }), 1000)).toBe(true);
  });
});

describe("download parts and names", () => {
  it("splits big clear-outs into parts under the limit", () => {
    const parts = batchFiles([{ size: 40 }, { size: 50 }, { size: 20 }, { size: 200 }, { size: 5 }], 100);
    expect(parts.map((p) => p.map((f) => f.size))).toEqual([[40, 50], [20], [200], [5]]);
  });
  it("names files by date and description, safely and without clashes", () => {
    expect(
      archiveNames([
        { date: "2026-03-04", description: "Postage / 3 orders", filename: "IMG_1.jpg" },
        { date: "2026-03-04", description: "Postage / 3 orders", filename: "IMG_1.jpg" },
      ]),
    ).toEqual(["2026-03-04 Postage _ 3 orders - IMG_1.jpg", "2026-03-04 Postage _ 3 orders - IMG_1 (2).jpg"]);
  });
});
