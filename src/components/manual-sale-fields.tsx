"use client";

import { useState } from "react";
import { Field } from "@/components/ui";
import { MANUAL_KINDS } from "@/lib/manual-sales";

/** A merch item to pick for a hand-added sale: "<release id>:<package id>" (or just "<release id>:"), and its band. */
export type MerchChoice = { value: string; label: string; bandId: number | null };

/**
 * The hand-added sale's band (a choice only when there's more than one), what it was, and for merch,
 * which item (optional). Picking an item is enough to say what it was.
 */
export function ManualSaleFields({ bands, merch }: { bands: { id: number; name: string }[]; merch: MerchChoice[] }) {
  const [bandId, setBandId] = useState(bands.length === 1 ? String(bands[0].id) : "");
  const [kind, setKind] = useState<string>("show");
  const [item, setItem] = useState("");
  const items = merch.filter((m) => !bandId || m.bandId === null || String(m.bandId) === bandId);
  return (
    <>
      {bands.length === 1 ? (
        <input type="hidden" name="bandId" value={bands[0].id} />
      ) : (
        <Field label="Band">
          <select
            name="bandId"
            required
            value={bandId}
            onChange={(e) => {
              setBandId(e.target.value);
              setItem("");
            }}
          >
            <option value="" disabled>
              Choose a band
            </option>
            {bands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="What it was">
        <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          {MANUAL_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </Field>
      {kind === "merch" && items.length > 0 && (
        <Field label="Item (optional)">
          <select name="item" value={item} onChange={(e) => setItem(e.target.value)}>
            <option value="">Not one of these</option>
            {items.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Description" className="sm:col-span-3">
        <input name="itemName" required={!(kind === "merch" && item)} maxLength={200} />
      </Field>
    </>
  );
}
