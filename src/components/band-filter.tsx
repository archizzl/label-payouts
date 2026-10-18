"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

/** Up to this many bands are each a button; more (a big label's roster) are a list to pick from. */
const BUTTONS_UP_TO = 8;

type Choice = { href: string; label: string; on: boolean };

/**
 * Pick a band to narrow a page to (`<path>?band=<id>`), or all of them: a row of buttons, or for a
 * label with many bands, "all" and a list. `extras` sit next to "all" (Receipts' "mine", say).
 */
export function BandFilter({
  path,
  bands,
  current,
  all,
  extras = [],
  look = "pills",
  label,
}: {
  path: string;
  bands: { id: number; name: string }[];
  current: number | null | undefined;
  all: string;
  extras?: Choice[];
  /** Rounded buttons, or underlined tabs (Payouts' "pay:"). */
  look?: "pills" | "tabs";
  /** A word before the choices (Payouts' "pay:"). */
  label?: string;
}) {
  const router = useRouter();
  const hrefOf = (id: number) => `${path}?band=${id}`;
  const choice = (c: Choice) => (
    <Link
      key={c.href}
      href={c.href}
      scroll={false}
      className={
        look === "pills"
          ? `rounded-full px-3 py-1 hover:no-underline ${c.on ? "bg-text text-bg" : "bg-surface-2 text-muted hover:text-text"}`
          : `border-b-2 pb-0.5 hover:no-underline ${c.on ? "border-accent font-bold text-text" : "border-transparent text-muted hover:text-text"}`
      }
    >
      {c.label}
    </Link>
  );
  const allOn = !current && !extras.some((e) => e.on);
  const many = bands.length > BUTTONS_UP_TO;
  return (
    <nav className={`mb-6 flex flex-wrap items-center text-sm ${look === "pills" ? "gap-2" : "gap-x-5 gap-y-2"}`} aria-label="Band">
      {label && <span className="text-muted">{label}</span>}
      {choice({ href: path, label: all, on: allOn })}
      {extras.map(choice)}
      {many ? (
        <select
          value={current ?? ""}
          onChange={(e) => router.push(e.target.value ? hrefOf(Number(e.target.value)) : path, { scroll: false })}
          aria-label="Band"
          className={`!w-auto max-w-full !py-1 text-sm ${current ? "" : "text-muted"}`}
        >
          <option value="">{bands.length} bands…</option>
          {[...bands]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
        </select>
      ) : (
        bands.map((b) => choice({ href: hrefOf(b.id), label: b.name, on: current === b.id }))
      )}
    </nav>
  );
}
