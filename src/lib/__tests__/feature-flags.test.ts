import { describe, expect, it } from "vitest";
import { featureVisible, inAudience } from "../feature-flags";

describe("who sees a flagged feature", () => {
  it("site admins by default; anyone given it; a site admin's own choice wins", () => {
    expect(featureVisible({ pref: null, granted: false, siteAdmin: true })).toBe(true);
    expect(featureVisible({ pref: null, granted: false, siteAdmin: false })).toBe(false);
    expect(featureVisible({ pref: null, granted: true, siteAdmin: false })).toBe(true);
    expect(featureVisible({ pref: false, granted: true, siteAdmin: true })).toBe(false);
    expect(featureVisible({ pref: true, granted: false, siteAdmin: true })).toBe(true);
  });

  it("kinds of account, by role and the kind of group they're in", () => {
    const labelOwner = { role: "owner", kind: "label" } as const;
    const bandMember = { role: "member", kind: "band" } as const;
    expect(inAudience("everyone", bandMember)).toBe(true);
    expect(inAudience("admins", labelOwner)).toBe(true);
    expect(inAudience("admins", bandMember)).toBe(false);
    expect(inAudience("members", bandMember)).toBe(true);
    expect(inAudience("members", { role: "admin", kind: "band" })).toBe(false);
    expect(inAudience("labels", labelOwner)).toBe(true);
    expect(inAudience("labels", bandMember)).toBe(false);
    expect(inAudience("bands", bandMember)).toBe(true);
    expect(inAudience("somebody", labelOwner)).toBe(false);
  });
});
