import { describe, expect, it } from "vitest";
import { featureVisible } from "../feature-flags";

describe("who sees a flagged feature", () => {
  it("site admins by default; accounts given it; a site admin's own choice wins", () => {
    expect(featureVisible({ pref: null, accountHasIt: false, siteAdmin: true })).toBe(true);
    expect(featureVisible({ pref: null, accountHasIt: false, siteAdmin: false })).toBe(false);
    expect(featureVisible({ pref: null, accountHasIt: true, siteAdmin: false })).toBe(true);
    expect(featureVisible({ pref: false, accountHasIt: true, siteAdmin: true })).toBe(false);
    expect(featureVisible({ pref: true, accountHasIt: false, siteAdmin: true })).toBe(true);
  });
});
