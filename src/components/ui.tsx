import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { formatCents } from "@/lib/money";

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[28px] leading-tight font-bold">{title}</h1>
        {subtitle && <p className="mt-1 text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** A section: bold heading over a hairline rule, content on the page (no heavy boxes). */
export function Card({ title, actions, children, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`mb-10 ${className}`}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2 border-b border-border pb-2">
          <h2 className="text-base font-bold">{title}</h2>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div>{children}</div>
    </section>
  );
}

const buttonStyles = {
  primary: "border border-accent bg-accent text-accent-fg hover:brightness-95",
  secondary: "border border-border bg-surface text-text hover:border-muted",
  danger: "border border-border bg-surface text-bad hover:border-bad",
  ghost: "border border-transparent text-link hover:underline",
};

export function buttonClass(variant: keyof typeof buttonStyles = "secondary", size: "sm" | "md" = "md") {
  // Bandcamp's controls speak in lowercase: "buy now", "share / embed".
  return `inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-sm lowercase whitespace-nowrap transition hover:no-underline disabled:cursor-default disabled:opacity-50 ${
    size === "sm" ? "px-2.5 py-[3px] text-xs" : "px-4 py-[7px] text-sm font-bold"
  } ${buttonStyles[variant]}`;
}

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  ...props
}: ComponentProps<"button"> & { variant?: keyof typeof buttonStyles; size?: "sm" | "md" }) {
  return <button className={`${buttonClass(variant, size)} ${className}`} {...props} />;
}

export function LinkButton({
  variant = "secondary",
  size = "md",
  className = "",
  ...props
}: ComponentProps<typeof Link> & { variant?: keyof typeof buttonStyles; size?: "sm" | "md" }) {
  return <Link className={`${buttonClass(variant, size)} ${className}`} {...props} />;
}

export function Field({ label, hint, children, className = "" }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Money({ cents, currency = "USD", className = "" }: { cents: number; currency?: string; className?: string }) {
  return (
    <span className={`tabular-nums ${cents < 0 ? "text-bad" : ""} ${className}`}>{formatCents(cents, currency)}</span>
  );
}

/** Totals keyed by currency, shown as "$12.00 · £3.00". */
export function MoneyList({ totals }: { totals: Map<string, number> | Record<string, number> }) {
  const entries = totals instanceof Map ? [...totals] : Object.entries(totals);
  if (entries.length === 0) return <span className="text-muted">—</span>;
  return (
    <span>
      {entries.map(([cur, c], i) => (
        <span key={cur}>
          {i > 0 && <span className="text-muted"> · </span>}
          <Money cents={c} currency={cur} />
        </span>
      ))}
    </span>
  );
}

const badgeTones = {
  neutral: "border-border text-muted",
  good: "border-good/40 text-good",
  warn: "border-warn/40 text-warn",
  bad: "border-bad/40 text-bad",
  accent: "border-accent/50 text-accent",
};

export function Badge({ tone = "neutral", children }: { tone?: keyof typeof badgeTones; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-sm border px-1.5 py-px text-xs lowercase ${badgeTones[tone]}`}>{children}</span>;
}

export function Callout({ tone = "warn", children }: { tone?: "warn" | "bad" | "good" | "neutral"; children: ReactNode }) {
  const t = {
    warn: "border-warn/30 bg-warn-bg text-warn",
    bad: "border-bad/30 bg-bad-bg text-bad",
    good: "border-good/30 bg-good-bg text-good",
    neutral: "border-border bg-surface-2 text-muted",
  }[tone];
  return <div className={`mb-5 border border-l-4 px-4 py-2.5 text-sm ${t}`}>{children}</div>;
}

/** What an empty section says. Quiet and left-aligned, like the rest of the page's text. */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="mb-3 text-sm text-muted">{children}</p>;
}

/** A disclosure used for inline add / edit forms. Always starts closed. */
export function Disclosure({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details className="group">
      <summary className={buttonClass("secondary", "sm")}>{summary}</summary>
      <div className="mt-3 border border-border bg-surface-2 p-4 text-left">{children}</div>
    </details>
  );
}

export function RolesList({ roles }: { roles: string[] }) {
  if (roles.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {roles.map((r) => (
        <Badge key={r}>{r}</Badge>
      ))}
    </span>
  );
}
