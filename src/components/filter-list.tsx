"use client";

import { type ReactNode, useRef, useState } from "react";

/**
 * A search box over a long list: hides the items inside (anything with `data-filter`, its text to
 * match) that don't contain every word typed. Hidden checkboxes are still sent with their form.
 */
export function FilterList({ placeholder, children, className = "" }: { placeholder: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<{ n: number; of: number } | null>(null);
  const filter = (q: string) => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("[data-filter]") ?? []);
    let n = 0;
    for (const el of items) {
      const text = el.dataset.filter!.toLowerCase();
      const match = words.every((w) => text.includes(w));
      el.hidden = !match;
      if (match) n++;
    }
    setShown(words.length ? { n, of: items.length } : null);
  };
  return (
    <div className={className}>
      <div className="mb-2 flex items-center gap-3">
        <input
          type="search"
          placeholder={placeholder}
          onChange={(e) => filter(e.target.value)}
          // Enter in the box shouldn't submit the form it sits in.
          onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
          className="!w-64 !py-1 !text-sm"
        />
        {shown && <span className="text-xs text-muted">{shown.n === 0 ? "No matches." : `${shown.n} of ${shown.of}`}</span>}
      </div>
      <div ref={ref}>{children}</div>
    </div>
  );
}
