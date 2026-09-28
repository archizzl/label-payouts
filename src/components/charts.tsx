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
export function MonthlyColumns({ data, currency }: { data: { month: string; net: number; units: number }[]; currency: string }) {
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
      title: `${MONTHS[mm - 1]} ${yy} · ${d.units} item${d.units === 1 ? "" : "s"}`,
      lines: [formatCents(d.net, currency)],
    });
  };

  return (
    <div ref={wrap} className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="Net sales by month">
        {t.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke={v === 0 ? "var(--chart-baseline)" : "var(--chart-grid)"} strokeWidth={1} />
            <text x={pad.l - 6} y={y(v)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--muted)" className="tabular-nums">
              {compact(v, currency)}
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
                aria-label={`${MONTHS[mm - 1]} ${yy}: ${formatCents(d.net, currency)}`}
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
export function BarList({ data, currency, total }: { data: { key: string; net: number; units: number }[]; currency: string; total: number }) {
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
            title: `${d.key} · ${d.units} item${d.units === 1 ? "" : "s"} · ${pct}% of net`,
            lines: [formatCents(d.net, currency)],
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
            <span className="text-right tabular-nums">{formatCents(d.net, currency)}</span>
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
