import { describe, expect, it } from "vitest";
import { describeActionError } from "../action-errors";

describe("describeActionError", () => {
  it("explains stale pages and dropped connections", () => {
    for (const m of ['Failed to find Server Action "abc". This request might be from an older or newer deployment.', "An unexpected response was received from the server.", "Failed to fetch"]) {
      expect(describeActionError(new Error(m))).toMatch(/Reload this page/);
    }
  });
  it("passes other errors through", () => {
    expect(describeActionError(new Error("Band name is required"))).toBe("Band name is required");
  });
});
