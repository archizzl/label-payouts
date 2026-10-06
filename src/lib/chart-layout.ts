/*
 * Customizable chart boards: which charts a person shows in a chart area, in what order and format.
 * Pure (no database, no React) so the server and the browser agree on what a valid layout is.
 */

export type ChartFormat = "bar" | "column" | "line" | "pie" | "table" | "stacked";

/** What a chart's data looks like, which decides the formats it can be shown in. */
export type DataShape = "series" | "breakdown" | "parts" | "owed" | "held-sent" | "spent-made";

/** Formats each shape allows, the first being the usual one. Line is only for time; pie only for parts of a whole. */
export const FORMATS_FOR: Record<DataShape, ChartFormat[]> = {
  series: ["column", "line", "table"],
  breakdown: ["bar", "pie", "line", "table"],
  parts: ["stacked", "pie", "table"],
  owed: ["stacked", "table"],
  "held-sent": ["stacked", "table"],
  "spent-made": ["line", "table"],
};

export const FORMAT_LABEL: Record<ChartFormat, string> = {
  bar: "Bars",
  column: "Columns",
  line: "Line",
  pie: "Pie",
  table: "Table",
  stacked: "Stacked bars",
};

/** One chart a board can show. */
export type KindSpec = {
  kind: string;
  title: string;
  shape: DataShape;
  /** e.g. pie isn't offered when a breakdown has negative totals. */
  formats?: ChartFormat[];
  /** Takes the board's full width (time charts, long lists). */
  wide?: boolean;
};

export type LayoutItem = { uid: string; kind: string; format: ChartFormat };
export type Layout = LayoutItem[];

export const MAX_CHARTS = 24;

export function allowedFormats(spec: Pick<KindSpec, "shape" | "formats">): ChartFormat[] {
  return spec.formats?.length ? spec.formats : FORMATS_FOR[spec.shape];
}

/** A board's default layout from its kinds and their formats, e.g. defaultLayout([["month"], ["band", "pie"]]). */
export function defaultLayout(items: [kind: string, format?: ChartFormat][], specs: KindSpec[]): Layout {
  return items.flatMap(([kind, format]) => {
    const spec = specs.find((s) => s.kind === kind);
    if (!spec) return [];
    const allowed = allowedFormats(spec);
    return [{ uid: kind, kind, format: format && allowed.includes(format) ? format : allowed[0] }];
  });
}

/**
 * A saved layout made safe to show: unknown kinds (a chart that isn't available here, e.g. filtered
 * out) and formats a chart can't take are dropped or fixed, duplicates of an id are renamed, and the
 * list is capped. Anything unreadable falls back to the defaults.
 */
export function normalizeLayout(saved: unknown, defaults: Layout, specs: KindSpec[]): Layout {
  if (!Array.isArray(saved)) return defaults;
  const seen = new Set<string>();
  const out: Layout = [];
  for (const raw of saved) {
    if (out.length >= MAX_CHARTS) break;
    if (!raw || typeof raw !== "object") continue;
    const { uid, kind, format } = raw as Record<string, unknown>;
    if (typeof kind !== "string") continue;
    const spec = specs.find((s) => s.kind === kind);
    if (!spec) continue;
    const allowed = allowedFormats(spec);
    let id = typeof uid === "string" && uid ? uid.slice(0, 40) : kind;
    while (seen.has(id)) id = `${id}+`;
    seen.add(id);
    out.push({ uid: id, kind, format: allowed.includes(format as ChartFormat) ? (format as ChartFormat) : allowed[0] });
  }
  return out;
}

/** Whether something looks like a layout worth storing (the server re-checks before saving). */
export function isLayoutShape(v: unknown): v is Layout {
  return (
    Array.isArray(v) &&
    v.length <= MAX_CHARTS &&
    v.every(
      (x) =>
        x &&
        typeof x === "object" &&
        typeof x.uid === "string" &&
        x.uid.length <= 40 &&
        typeof x.kind === "string" &&
        x.kind.length <= 40 &&
        typeof x.format === "string" &&
        x.format in FORMAT_LABEL,
    )
  );
}
