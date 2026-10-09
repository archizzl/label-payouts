import { describe, expect, it } from "vitest";
import { type Access, bandScope, can, describePermissions, inBandScope, normalizeBandAreas, normalizePermissions } from "../permissions";

const member = (permissions: Access["permissions"], bandAreas: Access["bandAreas"] = [], bandIds = [1]): Access => ({ admin: false, permissions, bandAreas, bandIds });

describe("member permissions", () => {
  it("admins can do everything; plain members nothing beyond their own earnings", () => {
    const admin: Access = { admin: true, permissions: {}, bandAreas: [], bandIds: [] };
    expect(can(admin, "payouts", "edit")).toBe(true);
    expect(bandScope(admin, "orders")).toBeNull();
    expect(can(member({}), "sales")).toBe(false);
  });

  it("change includes view; view doesn't include change", () => {
    const manager = member({ orders: "edit", sales: "view" });
    expect(can(manager, "orders")).toBe(true);
    expect(can(manager, "orders", "edit")).toBe(true);
    expect(can(manager, "sales", "edit")).toBe(false);
    expect(can(manager, "payouts")).toBe(false);
  });

  it("limits sections to their own bands only where it's set", () => {
    const manager = member({ orders: "edit", sales: "view" }, ["orders"], [3, 4]);
    expect(bandScope(manager, "orders")).toEqual([3, 4]);
    expect(bandScope(manager, "sales")).toBeNull();
    expect(inBandScope([3, 4], [5, 4])).toBe(true);
    expect(inBandScope([3, 4], [5, null])).toBe(false);
    expect(inBandScope(null, [])).toBe(true);
  });

  it("cleans up what's saved: unknown sections, bad levels, change where there's nothing to change", () => {
    expect(normalizePermissions({ orders: "edit", dashboard: "edit", nope: "edit", sales: "admin", fans: "none" })).toEqual({ orders: "edit", dashboard: "view" });
    expect(normalizeBandAreas(["orders", "payouts", "orders", 5])).toEqual(["orders"]);
  });

  it("describes a type in a line", () => {
    expect(describePermissions({ orders: "edit", sales: "view" }, ["orders"])).toBe("Sales: view · Orders: change (own bands)");
    expect(describePermissions({}, [])).toBe("Only their own earnings");
  });
});
