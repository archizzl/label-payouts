"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { BoardChart, ChartData } from "@/lib/chart-data";
import { allowedFormats, type ChartFormat, defaultLayout, FORMAT_LABEL, type Layout, type LayoutItem, normalizeLayout } from "@/lib/chart-layout";
import { formatCents } from "@/lib/money";
import { resetChartLayout, saveChartLayout } from "@/server/chart-actions";
import { BarList, DataTable, DonutChart, HeldSentBars, LineChart, MonthlyColumns, OwedBars, SpentVsMadeBack, StackedBar } from "./charts";

/*
 * A customizable chart area. Each chart has a small menu to change how it's shown, move it, or hide
 * it; "+ Add chart" brings back hidden ones (or a second copy in another format). Each person's
 * layout is saved for them as they go.
 */

const money = (v: number, unit: "money" | "count", currency: string) => (unit === "count" ? v.toLocaleString("en-US") : formatCents(v, currency));
const monthName = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
};

/** One chart's data, drawn in the chosen format. */
export function ChartView({ chart, format }: { chart: BoardChart; format: ChartFormat }) {
  const d: ChartData = chart.data;
  const title = chart.spec.title;
  switch (d.shape) {
    case "series": {
      if (format === "line") return <LineChart months={d.points.map((p) => p.month)} series={[{ key: title, values: d.points.map((p) => p.value) }]} unit={d.unit} currency={d.currency} label={title} />;
      if (format === "table") {
        const units = d.points.some((p) => p.units !== undefined && d.unit === "money");
        return (
          <DataTable
            columns={[{ label: "Month" }, ...(units ? [{ label: "Items", num: true }] : []), { label: d.unit === "money" ? "Amount" : "Count", num: true }]}
            rows={d.points.map((p) => [monthName(p.month), ...(units ? [p.units ?? 0] : []), money(p.value, d.unit, d.currency)])}
          />
        );
      }
      return <MonthlyColumns data={d.points.map((p) => ({ month: p.month, net: p.value, units: p.units ?? 0 }))} unit={d.unit} currency={d.currency} label={title} />;
    }
    case "breakdown": {
      const links = d.links?.length ? (
        <p className="mt-2 text-xs text-muted">
          {d.linksLabel ?? "See the sales for"}{" "}
          {d.links.map((l, i) => (
            <span key={l.href}>
              {i > 0 && ", "}
              <Link href={l.href}>{l.label}</Link>
            </span>
          ))}
          .
        </p>
      ) : null;
      if (format === "line")
        return d.trend?.months.length ? (
          <LineChart months={d.trend.months} series={d.trend.series} unit={d.unit} currency={d.currency} label={`${title} over time`} />
        ) : (
          <p className="text-sm text-muted">There’s no month-by-month data for this one.</p>
        );
      if (format === "pie")
        return (
          <>
            <DonutChart rows={d.rows.map((r) => ({ key: r.key, value: r.value }))} unit={d.unit} currency={d.currency} label={title} />
            {links}
          </>
        );
      if (format === "table")
        return (
          <>
            <DataTable
              columns={[{ label: "" }, ...(d.showUnits !== false && d.unit === "money" ? [{ label: "Items", num: true }] : []), { label: d.unit === "money" ? "Amount" : "Count", num: true }, { label: "Share", num: true }]}
              rows={d.rows.map((r) => [
                r.key,
                ...(d.showUnits !== false && d.unit === "money" ? [r.units ?? 0] : []),
                money(r.value, d.unit, d.currency),
                d.total ? `${((r.value / d.total) * 100).toFixed(1)}%` : "",
              ])}
            />
            {links}
          </>
        );
      return (
        <>
          <BarList
            data={d.rows.map((r) => ({ key: r.key, net: r.value, units: r.units ?? 0 }))}
            currency={d.currency}
            total={d.total}
            share={d.share}
            showUnits={d.showUnits}
            unit={d.unit}
          />
          {links}
        </>
      );
    }
    case "parts": {
      const total = d.segments.reduce((a, s) => a + Math.max(0, s.value), 0);
      const body =
        format === "pie" ? (
          <DonutChart rows={d.segments.map((s) => ({ key: s.label, value: s.value, color: s.color }))} currency={d.currency} label={title} />
        ) : format === "table" ? (
          <DataTable
            columns={[{ label: "" }, { label: "Amount", num: true }, { label: "Share", num: true }]}
            rows={d.segments.filter((s) => s.value !== 0).map((s) => [s.label, formatCents(s.value, d.currency), total ? `${((s.value / total) * 100).toFixed(1)}%` : ""])}
          />
        ) : (
          <StackedBar segments={d.segments} currency={d.currency} />
        );
      return (
        <>
          {d.caption && <p className="mb-3 text-xs text-muted">{d.caption}</p>}
          {body}
          {d.note && <p className="mt-2 text-xs text-muted">{d.note}</p>}
        </>
      );
    }
    case "owed":
      if (!d.groups.length) return <p className="text-sm text-muted">{d.empty}</p>;
      return (
        <>
          {d.groups.map((g) => (
            <div key={g.currency} className="mb-6 last:mb-0">
              <p className="mb-3 text-sm">
                <span className="text-2xl font-bold tabular-nums">{formatCents(g.grand, g.currency)}</span>{" "}
                <span className="text-muted">
                  owed in total{d.groups.length > 1 ? ` (${g.currency})` : ""}, across {g.whom}
                </span>
              </p>
              {format === "table" ? (
                <DataTable
                  columns={[{ label: "Band or group" }, ...d.parts.map((p) => ({ label: p.label, num: true })), { label: "Total", num: true }]}
                  rows={g.rows.map((r) => [
                    r.people.length ? `${r.name} (${r.people.join(", ")})` : r.name,
                    ...r.values.map((v) => (v ? formatCents(v, g.currency) : "–")),
                    formatCents(
                      r.values.reduce((a, v) => a + v, 0),
                      g.currency,
                    ),
                  ])}
                />
              ) : (
                <OwedBars rows={g.rows} parts={d.parts} currency={g.currency} />
              )}
            </div>
          ))}
        </>
      );
    case "held-sent":
      if (format === "table")
        return (
          <DataTable
            columns={[{ label: "Source" }, { label: "Came in", num: true }, { label: "Sent on", num: true }, { label: "Still held", num: true }]}
            rows={d.rows.map((r) => [r.key, formatCents(r.net, d.currency), formatCents(r.sent, d.currency), formatCents(Math.max(0, r.held), d.currency)])}
          />
        );
      return <HeldSentBars rows={d.rows} currency={d.currency} total={d.total} />;
    case "spent-made":
      if (format === "table")
        return (
          <DataTable
            columns={[{ label: "Month" }, { label: "Spent so far", num: true }, { label: "Made back so far", num: true }]}
            rows={d.points.map((p) => [monthName(p.month), formatCents(p.spent, d.currency), formatCents(p.madeBack, d.currency)])}
          />
        );
      return <SpentVsMadeBack data={d.points} currency={d.currency} budget={d.budget} />;
  }
}

/** Closes when clicking elsewhere or pressing Escape. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return { open, setOpen, ref };
}

const FORMAT_ICON: Record<ChartFormat, React.ReactNode> = {
  bar: (
    <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
      <rect x="2" y="3" width="11" height="2.5" rx="1" fill="currentColor" />
      <rect x="2" y="7" width="7" height="2.5" rx="1" fill="currentColor" />
      <rect x="2" y="11" width="9" height="2.5" rx="1" fill="currentColor" />
    </svg>
  ),
  column: (
    <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
      <rect x="2.5" y="7" width="2.5" height="7" rx="1" fill="currentColor" />
      <rect x="6.75" y="3" width="2.5" height="11" rx="1" fill="currentColor" />
      <rect x="11" y="9" width="2.5" height="5" rx="1" fill="currentColor" />
    </svg>
  ),
  line: (
    <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
      <polyline points="2,12 6,7 9,9 14,3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  ),
  pie: (
    <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
      <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="3" />
      <path d="M8 2.5 A5.5 5.5 0 0 1 13.5 8" fill="none" stroke="var(--bg)" strokeWidth="1" />
    </svg>
  ),
  table: (
    <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
      <path d="M2.5 3.5h11M2.5 8h11M2.5 12.5h11M6 3.5v9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  stacked: (
    <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
      <rect x="2" y="4" width="6" height="3" rx="1" fill="currentColor" />
      <rect x="8.75" y="4" width="4" height="3" rx="1" fill="currentColor" opacity="0.55" />
      <rect x="2" y="9" width="4" height="3" rx="1" fill="currentColor" />
      <rect x="6.75" y="9" width="6" height="3" rx="1" fill="currentColor" opacity="0.55" />
    </svg>
  ),
};

function ChartMenu({
  chart,
  item,
  first,
  last,
  onChange,
}: {
  chart: BoardChart;
  item: LayoutItem;
  first: boolean;
  last: boolean;
  onChange: (action: { format?: ChartFormat; move?: -1 | 1; hide?: true }) => void;
}) {
  const { open, setOpen, ref } = usePopover();
  const formats = allowedFormats(chart.spec);
  const act = (a: Parameters<typeof onChange>[0]) => {
    onChange(a);
    if (a.hide || a.move) setOpen(false);
  };
  return (
    <div ref={ref} className="no-print relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Options for ${chart.spec.title}`}
        title="Change, move or hide this chart"
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 w-7 items-center justify-center rounded-sm text-muted hover:bg-surface-2 hover:text-text"
      >
        <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
          <circle cx="3.5" cy="8" r="1.3" fill="currentColor" />
          <circle cx="8" cy="8" r="1.3" fill="currentColor" />
          <circle cx="12.5" cy="8" r="1.3" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-1 w-56 rounded-sm border border-border bg-surface p-2 text-sm shadow-md">
          {formats.length > 1 && (
            <>
              <div className="px-1 pb-1 text-xs text-muted">Show as</div>
              <div className="mb-2 flex flex-wrap gap-1">
                {formats.map((f) => (
                  <button
                    key={f}
                    type="button"
                    role="menuitemradio"
                    aria-checked={item.format === f}
                    title={FORMAT_LABEL[f]}
                    onClick={() => act({ format: f })}
                    className={`flex items-center gap-1 rounded-sm border px-2 py-1 text-xs ${
                      item.format === f ? "border-accent text-text" : "border-border text-muted hover:text-text"
                    }`}
                  >
                    {FORMAT_ICON[f]}
                    {FORMAT_LABEL[f]}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="border-t border-border pt-1">
            {!first && (
              <button type="button" role="menuitem" onClick={() => act({ move: -1 })} className="block w-full rounded-sm px-2 py-1 text-left hover:bg-surface-2">
                Move up
              </button>
            )}
            {!last && (
              <button type="button" role="menuitem" onClick={() => act({ move: 1 })} className="block w-full rounded-sm px-2 py-1 text-left hover:bg-surface-2">
                Move down
              </button>
            )}
            <button type="button" role="menuitem" onClick={() => act({ hide: true })} className="block w-full rounded-sm px-2 py-1 text-left hover:bg-surface-2">
              Hide
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AddMenu({ charts, layout, onAdd, onReset }: { charts: BoardChart[]; layout: Layout; onAdd: (kind: string) => void; onReset: () => void }) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div ref={ref} className="no-print relative inline-block">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="rounded-sm border border-dashed border-border px-3 py-1.5 text-sm text-muted hover:border-muted hover:text-text"
      >
        + Add chart
      </button>
      {open && (
        <div role="menu" className="absolute left-0 z-20 mt-1 w-64 rounded-sm border border-border bg-surface p-1 text-sm shadow-md">
          {charts.map((c) => {
            const shown = layout.some((l) => l.kind === c.spec.kind);
            return (
              <button
                key={c.spec.kind}
                type="button"
                role="menuitem"
                onClick={() => {
                  onAdd(c.spec.kind);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-surface-2"
              >
                <span className="w-3 text-good" aria-hidden>
                  {shown ? "✓" : ""}
                </span>
                <span className="flex-1">{c.spec.title}</span>
                {shown && <span className="text-xs text-muted">add another</span>}
              </button>
            );
          })}
          <div className="mt-1 border-t border-border px-2 pt-1.5 pb-1">
            <button
              type="button"
              onClick={() => {
                onReset();
                setOpen(false);
              }}
              className="text-xs text-link hover:underline"
            >
              Reset to default
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The board. `defaults` is what everyone sees until they change it; `saved` is this person's layout
 * (from loadLayout). With `plain`, charts get small headings instead of section headings (for a
 * board inside another card).
 */
export function ChartBoard({
  boardId,
  charts,
  defaults,
  saved,
  plain = false,
}: {
  boardId: string;
  charts: BoardChart[];
  defaults: [kind: string, format?: ChartFormat][];
  saved: unknown;
  plain?: boolean;
}) {
  const specs = charts.map((c) => c.spec);
  const fallback = defaultLayout(defaults, specs);
  const [layout, setLayout] = useState<Layout>(() => (saved ? normalizeLayout(saved, fallback, specs) : fallback));
  // Charts in a saved layout that aren't available here right now (e.g. filtered out): kept as saved.
  const [elsewhere] = useState<Layout>(() =>
    Array.isArray(saved) ? (saved as Layout).filter((x) => x && typeof x.kind === "string" && !specs.some((s) => s.kind === x.kind)) : [],
  );
  const dirty = useRef(false);

  useEffect(() => {
    if (!dirty.current) return;
    const t = setTimeout(() => void saveChartLayout(boardId, [...layout, ...elsewhere]), 500);
    return () => clearTimeout(t);
  }, [layout, elsewhere, boardId]);

  const update = (next: Layout) => {
    dirty.current = true;
    setLayout(next);
  };
  const change = (i: number, a: { format?: ChartFormat; move?: -1 | 1; hide?: true }) => {
    const next = [...layout];
    if (a.hide) next.splice(i, 1);
    else if (a.move) {
      const j = i + a.move;
      [next[i], next[j]] = [next[j], next[i]];
    } else if (a.format) next[i] = { ...next[i], format: a.format };
    update(next);
  };
  const add = (kind: string) => {
    const spec = specs.find((s) => s.kind === kind)!;
    let uid = kind;
    for (let n = 2; layout.some((l) => l.uid === uid); n++) uid = `${kind}-${n}`;
    const used = layout.filter((l) => l.kind === kind).map((l) => l.format);
    // A second copy starts in a different format than the first.
    const format = allowedFormats(spec).find((f) => !used.includes(f)) ?? allowedFormats(spec)[0];
    update([...layout, { uid, kind, format }]);
  };
  const reset = () => {
    dirty.current = false;
    setLayout(fallback);
    void resetChartLayout(boardId);
  };

  const shown = layout.map((item) => ({ item, chart: charts.find((c) => c.spec.kind === item.kind)! })).filter((x) => x.chart);

  return (
    <div className={plain ? "" : "mb-10"}>
      <div className="grid gap-x-8 gap-y-2 md:grid-cols-2">
        {shown.map(({ item, chart }, i) => {
          const wide =
            chart.spec.wide ||
            ["line", "column"].includes(item.format) ||
            (item.format === "table" && chart.data.shape !== "breakdown") ||
            chart.data.shape === "held-sent" ||
            chart.data.shape === "spent-made";
          return (
            <section key={item.uid} className={`${plain ? "mb-6" : "mb-8"} min-w-0 ${wide ? "md:col-span-2" : ""}`}>
              <div className={`mb-3 flex items-center justify-between gap-2 ${plain ? "" : "border-b border-border pb-2"}`}>
                <h3 className={plain ? "text-sm font-bold" : "text-base font-bold"}>
                  {chart.spec.title}
                  {chart.subtitle && <span className="ml-2 text-xs font-normal text-muted">{chart.subtitle}</span>}
                </h3>
                <ChartMenu chart={chart} item={item} first={i === 0} last={i === shown.length - 1} onChange={(a) => change(layout.indexOf(item), a)} />
              </div>
              <ChartView chart={chart} format={item.format} />
            </section>
          );
        })}
      </div>
      {shown.length === 0 && <p className="mb-3 text-sm text-muted">All charts here are hidden.</p>}
      <AddMenu charts={charts} layout={layout} onAdd={add} onReset={reset} />
    </div>
  );
}

