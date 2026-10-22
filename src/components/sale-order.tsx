"use client";

import { type ReactNode, useState } from "react";

/**
 * In the sales list: an order with several items (a Bandcamp order, or merch added by hand at once).
 * Its row of totals opens and closes the items' own rows under it. (The row is a "group", so its
 * cells can show which way it is with group-aria-expanded.)
 */
export function SaleOrder({ head, children }: { head: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr
        className="group cursor-pointer align-top hover:bg-surface-2"
        onClick={(e) => !(e.target as HTMLElement).closest("a, button, form") && setOpen(!open)}
        aria-expanded={open}
      >
        {head}
      </tr>
      {open && children}
    </>
  );
}
