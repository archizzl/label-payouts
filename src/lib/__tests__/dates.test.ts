import { describe, expect, it } from "vitest";
import { periodName, previousMonth } from "../dates";

describe("period dates", () => {
  it("names common ranges readably", () => {
    expect(periodName("2026-08-01", "2026-08-31")).toBe("August 2026");
    expect(periodName("2026-07-01", "2026-09-30")).toBe("Q3 2026");
    expect(periodName("2026-01-01", "2026-12-31")).toBe("2026");
    expect(periodName("2026-02-01", "2026-04-30")).toBe("February–April 2026");
    expect(periodName("2026-08-03", "2026-09-30")).toBe("Aug 3 – Sep 30, 2026");
    expect(periodName("2025-12-15", "2026-01-15")).toBe("Dec 15, 2025 – Jan 15, 2026");
  });
  it("finds the previous month", () => {
    expect(previousMonth("2026-09-24")).toEqual(["2026-08-01", "2026-08-31"]);
    expect(previousMonth("2026-01-05")).toEqual(["2025-12-01", "2025-12-31"]);
    expect(previousMonth("2024-03-10")).toEqual(["2024-02-01", "2024-02-29"]);
  });
});
