import { describe, expect, it } from "vitest";
import { buildTrend, breakdownChart } from "../chart-data";
import { allowedFormats, defaultLayout, isLayoutShape, MAX_CHARTS, normalizeLayout, type KindSpec } from "../chart-layout";

const specs: KindSpec[] = [
  { kind: "month", title: "By month", shape: "series" },
  { kind: "band", title: "By band", shape: "breakdown" },
  { kind: "owed", title: "Owed", shape: "owed" },
];

describe("chart layouts", () => {
  it("offers formats that fit the data", () => {
    expect(allowedFormats(specs[0])).toEqual(["column", "line", "table"]);
    expect(allowedFormats(specs[1])).toEqual(["bar", "pie", "line", "table"]);
    expect(allowedFormats({ shape: "breakdown", formats: ["bar", "table"] })).toEqual(["bar", "table"]);
  });

  it("builds defaults, falling back to a chart's usual format", () => {
    expect(defaultLayout([["month"], ["band", "pie"], ["owed", "pie"], ["gone"]], specs)).toEqual([
      { uid: "month", kind: "month", format: "column" },
      { uid: "band", kind: "band", format: "pie" },
      { uid: "owed", kind: "owed", format: "stacked" },
    ]);
  });

  it("cleans up a saved layout: unknown charts and formats, duplicate ids, too many", () => {
    const defaults = defaultLayout([["month"]], specs);
    expect(normalizeLayout("nonsense", defaults, specs)).toBe(defaults);
    expect(
      normalizeLayout(
        [
          { uid: "a", kind: "band", format: "pie" },
          { uid: "a", kind: "band", format: "line" },
          { uid: "x", kind: "nope", format: "bar" },
          { uid: "m", kind: "month", format: "pie" },
          null,
        ],
        defaults,
        specs,
      ),
    ).toEqual([
      { uid: "a", kind: "band", format: "pie" },
      { uid: "a+", kind: "band", format: "line" },
      { uid: "m", kind: "month", format: "column" },
    ]);
    const many = Array.from({ length: 40 }, (_, i) => ({ uid: `b${i}`, kind: "band", format: "bar" }));
    expect(normalizeLayout(many, defaults, specs)).toHaveLength(MAX_CHARTS);
    expect(normalizeLayout([], defaults, specs)).toEqual([]); // everything hidden stays hidden
  });

  it("checks what's saved", () => {
    expect(isLayoutShape([{ uid: "a", kind: "band", format: "bar" }])).toBe(true);
    expect(isLayoutShape([{ uid: "a", kind: "band", format: "sparkles" }])).toBe(false);
    expect(isLayoutShape("x")).toBe(false);
  });
});

describe("trend lines", () => {
  it("keeps the biggest few, adds up the rest as Other, and fills in quiet months", () => {
    const rows = [
      { month: "2026-01", key: "A", value: 500 },
      { month: "2026-03", key: "A", value: 100 },
      { month: "2026-01", key: "B", value: 300 },
      { month: "2026-03", key: "C", value: 50 },
      { month: "2026-03", key: "D", value: 40 },
    ];
    expect(buildTrend(rows, 2)).toEqual({
      months: ["2026-01", "2026-02", "2026-03"],
      series: [
        { key: "A", values: [500, 0, 100] },
        { key: "B", values: [300, 0, 0] },
        { key: "Other", values: [0, 0, 90] },
      ],
    });
    // One left over isn't worth an "Other": it gets its own line.
    expect(buildTrend(rows, 3).series.map((s) => s.key)).toEqual(["A", "B", "C", "D"]);
    expect(buildTrend([])).toEqual({ months: [], series: [] });
  });

  it("only offers pie for parts of a whole, and line when there's month-by-month data", () => {
    const trend = buildTrend([{ month: "2026-01", key: "A", value: 1 }]);
    expect(breakdownChart("b", "B", [{ key: "A", net: 5 }], { currency: "USD", total: 5, trend }).spec.formats).toEqual(["bar", "pie", "line", "table"]);
    expect(breakdownChart("b", "B", [{ key: "A", net: -5 }], { currency: "USD", total: -5, trend }).spec.formats).toEqual(["bar", "line", "table"]);
    expect(breakdownChart("b", "B", [{ key: "A", net: 5 }], { currency: "USD", total: 5 }).spec.formats).toEqual(["bar", "pie", "table"]);
  });
});
