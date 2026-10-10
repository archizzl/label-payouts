import { describe, expect, it } from "vitest";
import { applyMove, catalogCandidates, isLow } from "../inventory";

describe("inventory counts", () => {
  it("received adds, used and sold take away whatever sign is typed, recount sets it", () => {
    expect(applyMove(10, "received", 5)).toEqual({ delta: 5, onHandAfter: 15 });
    expect(applyMove(10, "used", 3)).toEqual({ delta: -3, onHandAfter: 7 });
    expect(applyMove(10, "sold", -3)).toEqual({ delta: -3, onHandAfter: 7 });
    expect(applyMove(10, "recount", 4)).toEqual({ delta: -6, onHandAfter: 4 });
    expect(applyMove(10, "other", -2)).toEqual({ delta: -2, onHandAfter: 8 });
  });
  it("never goes below zero", () => {
    expect(applyMove(2, "damaged", 5)).toEqual({ delta: -2, onHandAfter: 0 });
    expect(applyMove(2, "recount", -1)).toEqual({ delta: -2, onHandAfter: 0 });
  });
  it("is low at or below its level, if it has one", () => {
    expect(isLow({ onHand: 3, lowAt: 3 })).toBe(true);
    expect(isLow({ onHand: 4, lowAt: 3 })).toBe(false);
    expect(isLow({ onHand: 0, lowAt: null })).toBe(false);
  });
});

describe("adding the catalog's items", () => {
  const releases = [
    { id: 1, title: "Flags of the World", kind: "album" as const, bandId: 7, packages: [{ bandcampId: 11, title: "Compact Disc", sku: "FD-CD" }] },
    { id: 2, title: "Logo Shirt", kind: "merch" as const, bandId: 7, packages: [{ bandcampId: 22, title: "Logo Shirt", sku: null, options: [{ title: "M", sku: "S-M" }, { title: "L", sku: null }] }] },
    { id: 3, title: "Digital only", kind: "album" as const, bandId: 7, packages: [] },
  ];
  it("adds one per format and per size, named sensibly", () => {
    expect(catalogCandidates(releases, [])).toEqual([
      { name: "Flags of the World — Compact Disc", bandId: 7, releaseId: 1, packageId: 11, option: null, sku: "FD-CD" },
      { name: "Logo Shirt", bandId: 7, releaseId: 2, packageId: 22, option: "M", sku: "S-M" },
      { name: "Logo Shirt", bandId: 7, releaseId: 2, packageId: 22, option: "L", sku: null },
    ]);
  });
  it("skips what's already tracked", () => {
    expect(catalogCandidates(releases, [{ releaseId: 2, packageId: 22, option: "m" }, { releaseId: 1, packageId: 11, option: null }]).map((c) => c.option)).toEqual(["L"]);
  });
});
