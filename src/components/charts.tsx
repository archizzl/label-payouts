"use client";

import { type ReactNode, useRef, useState } from "react";
import { formatCents } from "@/lib/money";

/*
 * Small SVG charts in the app's style: thin marks, 4px rounded data-ends on a single baseline,
 * hairline grid, text in text colours (never the data colour), and a hover / keyboard-focus
 * tooltip on every mark. Every value shown in a tooltip is also in a table on the page.
 */

type Tip = { x: number; y: number; title: string; lines: string[] } | null;

function Tooltip({ tip }: { tip: Tip }) {
  if (!tip) return null;
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-sm border border-border bg-surface px-2.5 py-1.5 text-xs whitespace-nowrap shadow-sm"
      style={{ left: tip.x, top: tip.y - 8 }}
    >
      <div className="font-bold text-text">{tip.lines[0]}</div>
      <div className="text-muted">{tip.title}</div>
      {tip.lines.slice(1).map((l) => (
        <div key={l} className="text-muted">
          {l}
        </div>
      ))}
    </div>
  );
}

/** Clean axis ticks: 0 and up to 3 round steps covering max. */
function ticks(max: number): number[] {
  if (max <= 0) return [0];
  const raw = max / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

const compact = (cents: number, currency: string) => {
  const v = cents / 100;
  const sym = formatCents(0, currency).replace(/[\d.,\s]/g, "") || "";
  if (Math.abs(v) >= 1000) return `${sym}${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
  return `${sym}${Math.round(v)}`;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Net sales per month: one series, columns on a baseline. */
export function MonthlyColumns({
  data,
  currency = "USD",
  unit = "money",
  label = "Net sales by month",
}: {
  data: { month: string; net: number; units: number }[];
  currency?: string;
  /** "count": plain numbers (e.g. sign-ups), not money. */
  unit?: "money" | "count";
  label?: string;
}) {
  const fmt = (v: number) => (unit === "count" ? v.toLocaleString("en-US") : formatCents(v, currency));
  const axis = (v: number) => (unit === "count" ? (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v))) : compact(v, currency));
  const [tip, setTip] = useState<Tip>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const W = 640;
  const H = 180;
  const pad = { l: 44, r: 8, t: 10, b: 24 };
  const max = Math.max(0, ...data.map((d) => d.net));
  const t = ticks(max);
  const top = t[t.length - 1] || 1;
  const band = (W - pad.l - pad.r) / Math.max(1, data.length);
  const bw = Math.min(24, band * 0.6);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - Math.max(0, v) / top);
  const every = Math.ceil(data.length / 12); // at most ~12 month labels

  const show = (e: { currentTarget: SVGElement }, d: (typeof data)[number]) => {
    const r = e.currentTarget.getBoundingClientRect();
    const box = wrap.current!.getBoundingClientRect();
    const [yy, mm] = d.month.split("-").map(Number);
    setTip({
      x: r.left - box.left + r.width / 2,
      y: r.top - box.top,
      title: unit === "count" ? `${MONTHS[mm - 1]} ${yy}` : `${MONTHS[mm - 1]} ${yy} · ${d.units} item${d.units === 1 ? "" : "s"}`,
      lines: [fmt(d.net)],
    });
  };

  return (
    <div ref={wrap} className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={label}>
        {t.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke={v === 0 ? "var(--chart-baseline)" : "var(--chart-grid)"} strokeWidth={1} />
            <text x={pad.l - 6} y={y(v)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--muted)" className="tabular-nums">
              {axis(v)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = pad.l + band * i + (band - bw) / 2;
          const h = y(0) - y(d.net);
          const [yy, mm] = d.month.split("-").map(Number);
          return (
            <g key={d.month}>
              {/* Hit target: the whole band, bigger than the mark. */}
              <rect
                x={pad.l + band * i}
                y={pad.t}
                width={band}
                height={H - pad.t - pad.b}
                fill="transparent"
                tabIndex={0}
                aria-label={`${MONTHS[mm - 1]} ${yy}: ${fmt(d.net)}`}
                onPointerMove={(e) => show(e, d)}
                onFocus={(e) => show(e, d)}
                onPointerLeave={() => setTip(null)}
                onBlur={() => setTip(null)}
                className="cursor-default outline-none"
              />
              {h > 0 && (
                <path
                  pointerEvents="none"
                  d={`M${x},${y(0)} V${y(d.net) + Math.min(4, h)} a4,4 0 0 1 4,-4 H${x + bw - Math.min(4, h)} a4,4 0 0 1 4,4 V${y(0)} Z`}
                  fill="var(--chart-accent)"
                  opacity={tip && tip.title.startsWith(`${MONTHS[mm - 1]} ${yy}`) ? 0.8 : 1}
                />
              )}
              {i % every === 0 && (
                <text x={pad.l + band * i + band / 2} y={H - 8} textAnchor="middle" fontSize={10} fill="var(--muted)">
                  {mm === 1 || i === 0 ? `${MONTHS[mm - 1]} ’${String(yy).slice(2)}` : MONTHS[mm - 1]}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

/** Ranked horizontal bars (by format, by source): label, bar, value at the tip. */
export function BarList({
  data,
  currency,
  total,
  share = "of net",
  showUnits = true,
  unit = "money",
}: {
  data: { key: string; net: number; units: number }[];
  currency: string;
  total: number;
  /** What the percentage in the tooltip is of. */
  share?: string;
  showUnits?: boolean;
  /** "count": plain numbers (e.g. fans), not money. */
  unit?: "money" | "count";
}) {
  const fmt = (v: number) => (unit === "count" ? v.toLocaleString("en-US") : formatCents(v, currency));
  const [tip, setTip] = useState<Tip>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const max = Math.max(1, ...data.map((d) => d.net));
  const shown = data.slice(0, 7);
  const rest = data.slice(7);
  const rows = rest.length
    ? [...shown, { key: `Other (${rest.length})`, net: rest.reduce((a, d) => a + d.net, 0), units: rest.reduce((a, d) => a + d.units, 0) }]
    : shown;

  return (
    <div ref={wrap} className="relative space-y-1.5">
      {rows.map((d) => {
        const pct = total ? Math.round((d.net / total) * 100) : 0;
        const show = (e: { currentTarget: HTMLElement }) => {
          const r = e.currentTarget.getBoundingClientRect();
          const box = wrap.current!.getBoundingClientRect();
          setTip({
            x: r.left - box.left + r.width / 2,
            y: r.top - box.top,
            title: `${d.key}${showUnits ? ` · ${d.units} item${d.units === 1 ? "" : "s"}` : ""} · ${pct}% ${share}`,
            lines: [fmt(d.net)],
          });
        };
        return (
          <div
            key={d.key}
            tabIndex={0}
            onPointerMove={show}
            onFocus={show}
            onPointerLeave={() => setTip(null)}
            onBlur={() => setTip(null)}
            className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 rounded-sm py-0.5 text-sm outline-none hover:bg-surface-2 focus-visible:bg-surface-2"
          >
            <span className="truncate text-muted">{d.key}</span>
            <span className="h-3">
              <span
                className="block h-3 rounded-r-[4px] bg-chart-accent"
                style={{ width: `${Math.max(0, (d.net / max) * 100)}%`, minWidth: d.net > 0 ? 2 : 0 }}
              />
            </span>
            <span className="text-right tabular-nums">{fmt(d.net)}</span>
          </div>
        );
      })}
      <Tooltip tip={tip} />
    </div>
  );
}

export type Segment = { key: string; label: string; value: number; color: string; note?: string };

/**
 * Part-to-whole as one horizontal bar: 2px surface gaps between segments, rounded outer ends,
 * a legend underneath (always, for identity), and a tooltip per segment.
 */
export function StackedBar({ segments, currency, footer }: { segments: Segment[]; currency: string; footer?: ReactNode }) {
  const [tip, setTip] = useState<Tip>(null);
  const [active, setActive] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const parts = segments.filter((s) => s.value > 0);
  const total = parts.reduce((a, s) => a + s.value, 0);
  if (total <= 0) return <p className="text-sm text-muted">Nothing to show yet.</p>;

  return (
    <div ref={wrap} className="relative">
      <div className="flex h-6 w-full gap-[2px] overflow-hidden rounded-[4px]" role="img" aria-label="Where the money went">
        {parts.map((s) => {
          const pct = (s.value / total) * 100;
          const show = (e: { currentTarget: HTMLElement }) => {
            const r = e.currentTarget.getBoundingClientRect();
            const box = wrap.current!.getBoundingClientRect();
            setActive(s.key);
            setTip({ x: r.left - box.left + r.width / 2, y: r.top - box.top, title: `${s.label} · ${pct.toFixed(1)}%`, lines: [formatCents(s.value, currency)] });
          };
          return (
            <div
              key={s.key}
              tabIndex={0}
              aria-label={`${s.label}: ${formatCents(s.value, currency)} (${pct.toFixed(1)}%)`}
              onPointerMove={show}
              onFocus={show}
              onPointerLeave={() => {
                setTip(null);
                setActive(null);
              }}
              onBlur={() => {
                setTip(null);
                setActive(null);
              }}
              className="h-full outline-none"
              style={{ width: `${pct}%`, minWidth: 3, background: s.color, opacity: active && active !== s.key ? 0.55 : 1 }}
            />
          );
        })}
      </div>
      <ul className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {segments.filter((s) => s.value !== 0).map((s) => (
          <li key={s.key} className="flex items-baseline gap-2">
            <span className="inline-block h-2.5 w-2.5 shrink-0 translate-y-[1px] rounded-[2px]" style={{ background: s.color }} />
            <span className="text-muted">{s.label}</span>
            <span className="ml-auto tabular-nums">{formatCents(s.value, currency)}</span>
            <span className="w-12 text-right text-xs text-muted tabular-nums">{total ? `${((s.value / total) * 100).toFixed(1)}%` : ""}</span>
          </li>
        ))}
      </ul>
      {footer}
      <Tooltip tip={tip} />
    </div>
  );
}

/**
 * A project's running totals: spent and made back, month by month, on one money axis (and its
 * budget as a dashed reference). The point where "made back" crosses "spent" is breaking even.
 * Crosshair + tooltip on hover or keyboard focus; the same numbers are in the table below it.
 */
export function SpentVsMadeBack({
  data,
  currency,
  budget,
}: {
  data: { month: string; spent: number; madeBack: number }[];
  currency: string;
  budget?: number | null;
}) {
  // The hovered month, and the chart's size on screen when it was hovered (for the tooltip).
  const [hoverAt, setHoverAt] = useState<{ i: number; w: number; h: number } | null>(null);
  const hover = hoverAt?.i ?? null;
  const wrap = useRef<HTMLDivElement>(null);
  const W = 640;
  const H = 220;
  const pad = { l: 48, r: 92, t: 12, b: 24 };
  const max = Math.max(0, budget ?? 0, ...data.map((d) => Math.max(d.spent, d.madeBack)));
  const t = ticks(max);
  const top = t[t.length - 1] || 1;
  const n = Math.max(1, data.length - 1);
  const x = (i: number) => pad.l + ((W - pad.l - pad.r) * i) / n;
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - Math.max(0, v) / top);
  const every = Math.ceil(data.length / 12);
  const series = [
    { key: "spent" as const, label: "Spent", color: "var(--series-2)" },
    { key: "madeBack" as const, label: "Made back", color: "var(--series-1)" },
  ];
  const label = (m: string) => {
    const [yy, mm] = m.split("-").map(Number);
    return `${MONTHS[mm - 1]} ${yy}`;
  };
  const path = (k: "spent" | "madeBack") => data.map((d, i) => `${i ? "L" : "M"}${x(i)},${y(d[k])}`).join(" ");
  const last = data[data.length - 1];
  // End labels sit at the line ends; nudge apart if they'd overlap.
  const ends = series.map((s) => ({ ...s, y: y(last?.[s.key] ?? 0) }));
  if (ends.length === 2 && Math.abs(ends[0].y - ends[1].y) < 14) {
    const mid = (ends[0].y + ends[1].y) / 2;
    const [a, b] = ends[0].y <= ends[1].y ? [0, 1] : [1, 0];
    ends[a].y = mid - 7;
    ends[b].y = mid + 7;
  }
  const h = hover !== null ? data[hover] : null;
  const setHover = (i: number) => {
    const r = wrap.current?.getBoundingClientRect();
    if (r) setHoverAt({ i, w: r.width, h: r.height });
  };

  if (!data.length) return null;
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-4 text-xs text-muted">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 rounded-full" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        {budget ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-4 border-t-2 border-dashed border-muted" />
            Budget
          </span>
        ) : null}
      </div>
      <div ref={wrap} className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full"
          role="img"
          aria-label="Spent and made back, running totals by month"
          onPointerLeave={() => setHoverAt(null)}
        >
          {t.map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke={v === 0 ? "var(--chart-baseline)" : "var(--chart-grid)"} strokeWidth={1} />
              <text x={pad.l - 6} y={y(v)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--muted)" className="tabular-nums">
                {compact(v, currency)}
              </text>
            </g>
          ))}
          {budget ? (
            <line x1={pad.l} x2={W - pad.r} y1={y(budget)} y2={y(budget)} stroke="var(--muted)" strokeWidth={1.5} strokeDasharray="4 4" />
          ) : null}
          {data.map((d, i) =>
            i % every === 0 ? (
              <text key={d.month} x={x(i)} y={H - 8} textAnchor="middle" fontSize={10} fill="var(--muted)">
                {(() => {
                  const [yy, mm] = d.month.split("-").map(Number);
                  return mm === 1 || i === 0 ? `${MONTHS[mm - 1]} ’${String(yy).slice(2)}` : MONTHS[mm - 1];
                })()}
              </text>
            ) : null,
          )}
          {h && hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="var(--chart-baseline)" strokeWidth={1} />}
          {series.map((s) => (
            <path key={s.key} d={path(s.key)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {h &&
            hover !== null &&
            series.map((s) => (
              <circle key={s.key} cx={x(hover)} cy={y(h[s.key])} r={4.5} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
            ))}
          {ends.map((s) => (
            <text key={s.key} x={W - pad.r + 8} y={s.y} dy="0.32em" fontSize={11} fill="var(--text)">
              {s.label} <tspan fill="var(--muted)">{compact(last[s.key], currency)}</tspan>
            </text>
          ))}
          {/* Hit targets: one column per month, wider than the lines. */}
          {data.map((d, i) => (
            <rect
              key={d.month}
              x={x(i) - (W - pad.l - pad.r) / n / 2}
              y={pad.t}
              width={(W - pad.l - pad.r) / n}
              height={H - pad.t - pad.b}
              fill="transparent"
              tabIndex={0}
              aria-label={`${label(d.month)}: spent ${formatCents(d.spent, currency)}, made back ${formatCents(d.madeBack, currency)}`}
              onPointerMove={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHoverAt(null)}
              className="cursor-default outline-none"
            />
          ))}
        </svg>
        {h && hoverAt && (
          <Tooltip
            tip={{
              x: (x(hoverAt.i) / W) * hoverAt.w,
              // Just above the higher of the two points.
              y: (Math.min(y(h.spent), y(h.madeBack)) / H) * hoverAt.h - 4,
              title: `${label(h.month)} · ${h.madeBack >= h.spent ? "made back " + formatCents(h.madeBack - h.spent, currency) + " more than spent" : formatCents(h.spent - h.madeBack, currency) + " still to make back"}`,
              lines: [`Spent ${formatCents(h.spent, currency)} · Made back ${formatCents(h.madeBack, currency)}`],
            }}
          />
        )}
      </div>
    </div>
  );
}

export type OwedBar = {
  key: string;
  name: string;
  href?: string;
  /** cents per part, in the order of `parts` */
  values: number[];
  /** Extra lines for the tooltip, e.g. who in the band it's owed to. */
  detail?: string[];
};

/**
 * Who's owed what: one stacked bar per band (or group) on a shared scale, parts in a fixed colour
 * order with 2px gaps, the total at the end of each row, a legend above, and a tooltip per part.
 */
export function OwedBars({ rows, parts, currency }: { rows: OwedBar[]; parts: { label: string; color: string }[]; currency: string }) {
  const [tip, setTip] = useState<Tip>(null);
  const [active, setActive] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const sum = (r: OwedBar) => r.values.reduce((a, v) => a + Math.max(0, v), 0);
  const max = Math.max(1, ...rows.map(sum));
  const used = parts.map((_, i) => rows.some((r) => r.values[i] > 0));

  return (
    <div ref={wrap} className="relative">
      <ul className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted" aria-label="Legend">
        {parts.map((p, i) =>
          used[i] ? (
            <li key={p.label} className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: p.color }} />
              {p.label}
            </li>
          ) : null,
        )}
      </ul>
      <div className="space-y-1.5">
        {rows.map((r) => {
          const t = sum(r);
          return (
            <div key={r.key} className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-3 text-sm sm:grid-cols-[minmax(0,10rem)_1fr_auto]">
              <span className="truncate text-muted" title={r.name}>
                {r.href ? (
                  <a href={r.href} className="hover:underline">
                    {r.name}
                  </a>
                ) : (
                  r.name
                )}
              </span>
              <span className="flex h-3 gap-[2px]" style={{ width: `${(t / max) * 100}%`, minWidth: t > 0 ? 3 : 0 }}>
                {r.values.map((v, i) => {
                  if (v <= 0) return null;
                  const id = `${r.key}:${i}`;
                  const last = r.values.slice(i + 1).every((x) => x <= 0);
                  const show = (e: { currentTarget: HTMLElement }) => {
                    const box = wrap.current!.getBoundingClientRect();
                    const b = e.currentTarget.getBoundingClientRect();
                    setActive(id);
                    setTip({
                      x: b.left - box.left + b.width / 2,
                      y: b.top - box.top,
                      title: `${r.name} · ${parts[i].label}`,
                      lines: [formatCents(v, currency), ...(r.detail ?? [])],
                    });
                  };
                  const hide = () => {
                    setTip(null);
                    setActive(null);
                  };
                  return (
                    <span
                      key={i}
                      tabIndex={0}
                      aria-label={`${r.name}, ${parts[i].label}: ${formatCents(v, currency)}`}
                      onPointerMove={show}
                      onFocus={show}
                      onPointerLeave={hide}
                      onBlur={hide}
                      className={`block h-full outline-none ${last ? "rounded-r-[4px]" : ""}`}
                      style={{ width: `${(v / t) * 100}%`, minWidth: 3, background: parts[i].color, opacity: active && active !== id ? 0.55 : 1 }}
                    />
                  );
                })}
              </span>
              <span className="text-right font-medium tabular-nums">{formatCents(t, currency)}</span>
            </div>
          );
        })}
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

/** Colours for several series in a fixed order; "Other" is always muted. */
export const seriesColor = (key: string, i: number) => (key === "Other" ? "var(--muted)" : `var(--series-${(i % 5) + 1})`);

function fmtValue(v: number, unit: "money" | "count", currency: string) {
  return unit === "count" ? v.toLocaleString("en-US") : formatCents(v, currency);
}

/**
 * Lines over months: one series, or several (a breakdown's trend: the biggest few and Other). Thin
 * lines on one axis, a crosshair tooltip with every series' value, a legend, and labels at the ends.
 */
export function LineChart({
  months,
  series,
  unit = "money",
  currency = "USD",
  label = "Over time",
}: {
  months: string[];
  series: { key: string; values: number[] }[];
  unit?: "money" | "count";
  currency?: string;
  label?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const multi = series.length > 1;
  const W = 640;
  const H = 200;
  const pad = { l: 44, r: 16, t: 10, b: 24 };
  const all = series.flatMap((s) => s.values);
  const max = Math.max(0, ...all);
  const min = Math.min(0, ...all);
  const t = ticks(max);
  const top = t[t.length - 1] || 1;
  const bottom = min < 0 ? -ticks(-min)[ticks(-min).length - 1] : 0;
  const n = Math.max(1, months.length - 1);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - (v - bottom) / (top - bottom || 1));
  const every = Math.ceil(months.length / 8);
  const axis = (v: number) => (unit === "count" ? String(Math.round(v)) : compact(v, currency));
  if (!months.length) return <p className="text-sm text-muted">Nothing to show yet.</p>;

  // End labels, nudged apart so they don't overlap.
  const ends = series
    .map((s, i) => ({ key: s.key, i, y: y(s.values[s.values.length - 1] ?? 0) }))
    .sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 12) ends[k].y = ends[k - 1].y + 12;
  // Label the line ends only when they fit inside the plot without crowding; the legend always names them.
  const labelEnds = multi && ends.length <= 6 && (ends[ends.length - 1]?.y ?? 0) <= H - pad.b + 2;
  // Room on the right for the end labels, only when they're shown.
  if (labelEnds) pad.r = 120;
  const x = (i: number) => pad.l + ((W - pad.l - pad.r) * i) / n;

  const pointer = (clientX: number) => {
    const box = wrap.current!.getBoundingClientRect();
    const px = ((clientX - box.left) / box.width) * W;
    setHover(Math.max(0, Math.min(months.length - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * n))));
  };
  const monthLabel = (m: string) => {
    const [yy, mm] = m.split("-").map(Number);
    return `${MONTHS[mm - 1]} ${yy}`;
  };

  return (
    <div ref={wrap} className="relative">
      {multi && (
        <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legend">
          {series.map((s, i) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-3" style={{ background: seriesColor(s.key, i) }} />
              {s.key}
            </li>
          ))}
        </ul>
      )}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full touch-none"
        role="img"
        aria-label={label}
        tabIndex={0}
        onPointerMove={(e) => pointer(e.clientX)}
        onPointerLeave={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") setHover((h) => Math.min(months.length - 1, (h ?? -1) + 1));
          if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? months.length) - 1));
        }}
        onBlur={() => setHover(null)}
      >
        {[...(bottom < 0 ? ticks(-bottom).slice(1).map((v) => -v) : []), ...t].map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke={v === 0 ? "var(--chart-baseline)" : "var(--chart-grid)"} strokeWidth={1} />
            <text x={pad.l - 6} y={y(v)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--muted)" className="tabular-nums">
              {axis(v)}
            </text>
          </g>
        ))}
        {months.map((m, i) =>
          i % every === 0 ? (
            <text key={m} x={x(i)} y={H - 8} textAnchor="middle" fontSize={10} fill="var(--muted)">
              {(() => {
                const [yy, mm] = m.split("-").map(Number);
                return mm === 1 || i === 0 ? `${MONTHS[mm - 1]} ’${String(yy).slice(2)}` : MONTHS[mm - 1];
              })()}
            </text>
          ) : null,
        )}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="var(--chart-baseline)" strokeWidth={1} />}
        {series.map((s, i) => (
          <g key={s.key}>
            <polyline
              points={s.values.map((v, k) => `${x(k)},${y(v)}`).join(" ")}
              fill="none"
              stroke={multi ? seriesColor(s.key, i) : "var(--chart-accent)"}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {hover !== null && (
              <circle cx={x(hover)} cy={y(s.values[hover])} r={4} fill={multi ? seriesColor(s.key, i) : "var(--chart-accent)"} stroke="var(--bg)" strokeWidth={2} />
            )}
          </g>
        ))}
        {labelEnds &&
          ends.map((e) => (
            <text key={e.key} x={W - pad.r + 6} y={e.y} dy="0.32em" fontSize={10} fill="var(--muted)">
              {e.key.length > 16 ? `${e.key.slice(0, 15)}…` : e.key}
            </text>
          ))}
      </svg>
      {hover !== null && (
        <div
          role="status"
          className="pointer-events-none absolute top-0 z-10 rounded-sm border border-border bg-surface px-2.5 py-1.5 text-xs whitespace-nowrap shadow-sm"
          style={{ left: `${(x(hover) / W) * 100}%`, transform: x(hover) > W / 2 ? "translateX(calc(-100% - 8px))" : "translateX(8px)" }}
        >
          <div className="font-bold text-text">{monthLabel(months[hover])}</div>
          {series
            .map((s, i) => ({ s, i, v: s.values[hover] }))
            .sort((a, b) => b.v - a.v)
            .map(({ s, i, v }) => (
              <div key={s.key} className="flex items-center gap-1.5 text-muted">
                {multi && <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: seriesColor(s.key, i) }} />}
                {multi && <span>{s.key}</span>}
                <span className="ml-auto pl-3 text-text tabular-nums">{fmtValue(v, unit, currency)}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

/**
 * Part-to-whole as a donut: at most 6 slices (the biggest five, then Other), 2px gaps, a legend
 * with each value and share, and a tooltip on hover or focus.
 */
export function DonutChart({
  rows,
  unit = "money",
  currency = "USD",
  label = "Share",
}: {
  rows: { key: string; value: number; color?: string }[];
  unit?: "money" | "count";
  currency?: string;
  label?: string;
}) {
  const [active, setActive] = useState<string | null>(null);
  const positive = rows.filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
  const slices =
    positive.length > 6
      ? [...positive.slice(0, 5), { key: "Other", value: positive.slice(5).reduce((a, r) => a + r.value, 0), color: "var(--muted)" }]
      : positive;
  const total = slices.reduce((a, r) => a + r.value, 0);
  if (total <= 0) return <p className="text-sm text-muted">Nothing to show yet.</p>;
  const R = 64;
  const r0 = 40;
  const cx = 80;
  const cy = 80;
  // Where each slice starts: the running total of the ones before it.
  const starts = slices.map((_, i) => slices.slice(0, i).reduce((a, r) => a + r.value, 0));
  const arcs = slices.map((s, i) => {
    const a0 = -Math.PI / 2 + (starts[i] / total) * Math.PI * 2;
    const a1 = a0 + (s.value / total) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad: number, r: number) => `${cx + r * Math.cos(rad)},${cy + r * Math.sin(rad)}`;
    const full = slices.length === 1;
    const d = full
      ? `M${cx - R},${cy} a${R},${R} 0 1,0 ${R * 2},0 a${R},${R} 0 1,0 ${-R * 2},0 M${cx - r0},${cy} a${r0},${r0} 0 1,1 ${r0 * 2},0 a${r0},${r0} 0 1,1 ${-r0 * 2},0`
      : `M${p(a0, R)} A${R},${R} 0 ${large} 1 ${p(a1, R)} L${p(a1, r0)} A${r0},${r0} 0 ${large} 0 ${p(a0, r0)} Z`;
    return { ...s, d, color: s.color ?? seriesColor(s.key, i) };
  });
  const shown = active ? arcs.find((a) => a.key === active) : null;
  return (
    <div className="flex flex-wrap items-center gap-6">
      <svg viewBox="0 0 160 160" className="h-40 w-40 shrink-0" role="img" aria-label={label}>
        {arcs.map((a) => (
          <path
            key={a.key}
            d={a.d}
            fill={a.color}
            fillRule="evenodd"
            stroke="var(--bg)"
            strokeWidth={2}
            opacity={active && active !== a.key ? 0.5 : 1}
            tabIndex={0}
            aria-label={`${a.key}: ${fmtValue(a.value, unit, currency)} (${((a.value / total) * 100).toFixed(1)}%)`}
            onPointerEnter={() => setActive(a.key)}
            onPointerLeave={() => setActive(null)}
            onFocus={() => setActive(a.key)}
            onBlur={() => setActive(null)}
            className="outline-none"
          />
        ))}
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize={11} fill="var(--muted)">
          {shown ? (shown.key.length > 12 ? `${shown.key.slice(0, 11)}…` : shown.key) : "Total"}
        </text>
        <text x={cx} y={cy + 12} textAnchor="middle" fontSize={13} fontWeight={700} fill="var(--text)" className="tabular-nums">
          {unit === "count" ? (shown ?? { value: total }).value.toLocaleString("en-US") : compact((shown ?? { value: total }).value, currency)}
        </text>
      </svg>
      <ul className="min-w-0 max-w-md flex-1 basis-56 space-y-1 text-sm">
        {arcs.map((a) => (
          <li
            key={a.key}
            className={`flex items-baseline gap-2 ${active && active !== a.key ? "opacity-60" : ""}`}
            onPointerEnter={() => setActive(a.key)}
            onPointerLeave={() => setActive(null)}
          >
            <span className="inline-block h-2.5 w-2.5 shrink-0 translate-y-[1px] rounded-[2px]" style={{ background: a.color }} />
            <span className="truncate text-muted">{a.key}</span>
            <span className="ml-auto tabular-nums">{fmtValue(a.value, unit, currency)}</span>
            <span className="w-12 text-right text-xs text-muted tabular-nums">{((a.value / total) * 100).toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Any chart's numbers as a plain table: the accessible, exact view. */
export function DataTable({ columns, rows }: { columns: { label: string; num?: boolean }[]; rows: (string | number)[][] }) {
  if (!rows.length) return <p className="text-sm text-muted">Nothing to show yet.</p>;
  return (
    <div className="max-h-96 overflow-auto">
      <table className="data">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.label} className={c.num ? "num" : ""}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((v, k) => (
                <td key={k} className={columns[k]?.num ? "num" : ""}>
                  {v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const HELD = "var(--series-1)";
const SENT = "var(--series-2)";

/** The label's income sources: a bar each, split into still held and sent on, on a shared scale. */
export function HeldSentBars({
  rows,
  currency,
  total,
}: {
  rows: { key: string; explain: string; net: number; sent: number; held: number }[];
  currency: string;
  total: number;
}) {
  const done = rows.filter((r) => r.sent > 0 && r.held <= 0);
  const open = rows.filter((r) => !done.includes(r));
  const max = Math.max(1, ...rows.map((x) => Math.max(x.net, x.sent)));
  const list = (items: typeof rows) => (
    <ul className="space-y-3">
      {items.map((src) => {
        const held = Math.max(0, src.held);
        return (
          <li key={src.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 text-sm sm:grid-cols-[minmax(0,16rem)_1fr_auto]">
            <div>
              <div className="font-medium">{src.key}</div>
              <div className="text-xs text-muted">{src.explain}</div>
            </div>
            <span
              className="order-last col-span-2 mt-1 flex h-3 gap-[2px] sm:order-none sm:col-span-1"
              role="img"
              aria-label={`${src.key}: ${formatCents(held, currency)} still held, ${formatCents(src.sent, currency)} sent on`}
            >
              {held > 0 && (
                <span
                  className={`block h-3 ${src.sent > 0 ? "" : "rounded-r-[4px]"}`}
                  style={{ width: `${(held / max) * 100}%`, minWidth: 2, background: HELD }}
                  title={`Still held: ${formatCents(held, currency)}`}
                />
              )}
              {src.sent > 0 && (
                <span
                  className="block h-3 rounded-r-[4px]"
                  style={{ width: `${(src.sent / max) * 100}%`, minWidth: 2, background: SENT }}
                  title={`Sent on: ${formatCents(src.sent, currency)}`}
                />
              )}
            </span>
            <div className="text-right tabular-nums">
              {formatCents(src.net, currency)}
              {total > 0 && held > 0 && <div className="text-xs text-muted">{((held / total) * 100).toFixed(1)}% of what the label still holds</div>}
              {src.sent > 0 && (
                <div className="text-xs text-muted">
                  {formatCents(held, currency)} held · {formatCents(src.sent, currency)} sent on
                  {src.held < 0 && ` (${formatCents(-src.held, currency)} more than it brought in)`}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
  if (!rows.length) return <p className="text-sm text-muted">Nothing yet.</p>;
  return (
    <>
      <ul className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted" aria-label="Legend">
        <li className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: HELD }} />
          Still held by the label
        </li>
        <li className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: SENT }} />
          Sent on
        </li>
      </ul>
      {list(open)}
      {done.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-link">
            {done.length} source{done.length === 1 ? "" : "s"} fully sent on
          </summary>
          <div className="mt-3">{list(done)}</div>
        </details>
      )}
    </>
  );
}
