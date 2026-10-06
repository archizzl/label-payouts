import { FORMATS_FOR, type KindSpec } from "./chart-layout";

/*
 * The data behind each chart on a board, built on the server and drawn in the browser in whichever
 * format the person picked. Plain data only (it crosses from server to client).
 */

export type Unit = "money" | "count";
export type BreakdownRow = { key: string; value: number; units?: number };
/** Month by month for the biggest few keys (plus "Other"): what a breakdown's line chart draws. */
export type Trend = { months: string[]; series: { key: string; values: number[] }[] };
export type OwedChartRow = {
  key: string;
  name: string;
  href?: string;
  values: number[];
  detail?: string[];
  people: string[];
};

export type ChartData =
  | { shape: "series"; unit: Unit; currency: string; points: { month: string; value: number; units?: number }[] }
  | {
      shape: "breakdown";
      unit: Unit;
      currency: string;
      rows: BreakdownRow[];
      total: number;
      /** What a row's percentage is of, e.g. "of net". */
      share?: string;
      showUnits?: boolean;
      trend?: Trend;
      /** Optional links under the chart: label → href (e.g. "see the sales for X"). */
      links?: { label: string; href: string }[];
      linksLabel?: string;
    }
  | { shape: "parts"; currency: string; segments: { key: string; label: string; value: number; color: string }[]; note?: string; caption?: string }
  | {
      shape: "owed";
      parts: { label: string; color: string }[];
      groups: { currency: string; grand: number; whom: string; rows: OwedChartRow[] }[];
      empty: string;
    }
  | { shape: "held-sent"; currency: string; total: number; rows: { key: string; explain: string; net: number; sent: number; held: number }[] }
  | { shape: "spent-made"; currency: string; points: { month: string; spent: number; madeBack: number }[]; budget: number | null };

export type BoardChart = { spec: KindSpec; data: ChartData; subtitle?: string };

const nextMonth = (m: string) => {
  let [y, mo] = m.split("-").map(Number);
  mo++;
  if (mo > 12) [y, mo] = [y + 1, 1];
  return `${y}-${String(mo).padStart(2, "0")}`;
};

/** Every month from the first to the last, so quiet months show as zero. */
export function monthRange(first: string, last: string): string[] {
  const out: string[] = [];
  for (let m = first; m <= last && out.length < 600; m = nextMonth(m)) out.push(m);
  return out;
}

/**
 * A trend from month × key totals: the `top` keys with the biggest totals each get a line, the rest
 * are added up as "Other", across every month from the first to the last.
 */
export function buildTrend(rows: { month: string; key: string; value: number }[], top = 5, otherLabel = "Other"): Trend {
  const valid = rows.filter((r) => /^\d{4}-\d{2}$/.test(r.month));
  if (!valid.length) return { months: [], series: [] };
  const sorted = [...new Set(valid.map((r) => r.month))].sort();
  const months = monthRange(sorted[0], sorted[sorted.length - 1]);
  const totals = new Map<string, number>();
  for (const r of valid) totals.set(r.key, (totals.get(r.key) ?? 0) + r.value);
  const ranked = [...totals].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const keep = ranked.length > top + 1 ? ranked.slice(0, top) : ranked;
  const index = new Map(months.map((m, i) => [m, i]));
  const series = keep.map((key) => ({ key, values: months.map(() => 0) }));
  const other = { key: otherLabel, values: months.map(() => 0) };
  for (const r of valid) {
    const s = series.find((x) => x.key === r.key) ?? other;
    s.values[index.get(r.month)!] += r.value;
  }
  return { months, series: keep.length < ranked.length ? [...series, other] : series };
}

/** A breakdown chart's data from rows like { key, net, units }. Pie isn't offered if any total is negative. */
export function breakdownChart(
  kind: string,
  title: string,
  rows: { key: string; net: number; units?: number }[],
  opts: {
    currency: string;
    total: number;
    unit?: Unit;
    share?: string;
    showUnits?: boolean;
    trend?: Trend;
    links?: { label: string; href: string }[];
    linksLabel?: string;
    subtitle?: string;
  },
): BoardChart {
  // Pie needs parts of a whole (no negatives); line needs month-by-month data.
  const negative = rows.some((r) => r.net < 0);
  const formats = FORMATS_FOR.breakdown.filter((f) => !(f === "pie" && negative) && !(f === "line" && !opts.trend?.months.length));
  return {
    spec: { kind, title, shape: "breakdown", formats },
    subtitle: opts.subtitle,
    data: {
      shape: "breakdown",
      unit: opts.unit ?? "money",
      currency: opts.currency,
      rows: rows.map((r) => ({ key: r.key, value: r.net, units: r.units })),
      total: opts.total,
      share: opts.share,
      showUnits: opts.showUnits,
      trend: opts.trend,
      links: opts.links,
      linksLabel: opts.linksLabel,
    },
  };
}

/** A month-by-month chart's data. */
export function seriesChart(
  kind: string,
  title: string,
  points: { month: string; value: number; units?: number }[],
  opts: { currency: string; unit?: Unit; subtitle?: string },
): BoardChart {
  return { spec: { kind, title, shape: "series", wide: true }, subtitle: opts.subtitle, data: { shape: "series", unit: opts.unit ?? "money", currency: opts.currency, points } };
}
