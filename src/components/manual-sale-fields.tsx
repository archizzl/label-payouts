"use client";

import { useEffect, useRef, useState } from "react";
import { Field } from "@/components/ui";
import { MANUAL_KINDS } from "@/lib/manual-sales";

/** A merch item that can be sold by hand: "<release id>:<package id>" (or just "<release id>:"), its band and price. */
export type MerchChoice = { value: string; label: string; bandId: number | null; price: number | null };

/**
 * The hand-added sale's band (a choice only when there's more than one) and what it was. A show or
 * anything else is one amount; merch is every merch item the band has, each with its price and how
 * many were sold (and a line for anything not in the catalog).
 */
export function ManualSaleFields({ bands, merch, currency }: { bands: { id: number; name: string }[]; merch: MerchChoice[]; currency: string }) {
  const [bandId, setBandId] = useState(bands.length === 1 ? String(bands[0].id) : "");
  const [kind, setKind] = useState<string>("show");
  // The form resets itself after each add, which puts the select back to its first choice: put it
  // back to what's showing.
  const kindSelect = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    const select = kindSelect.current;
    const form = select?.form;
    if (!select || !form) return;
    const restore = () => setTimeout(() => (select.value = kind));
    form.addEventListener("reset", restore);
    return () => form.removeEventListener("reset", restore);
  }, [kind]);
  const items = merch.filter((m) => !bandId || m.bandId === null || String(m.bandId) === bandId);
  return (
    <>
      {bands.length === 1 ? (
        <input type="hidden" name="bandId" value={bands[0].id} />
      ) : (
        <Field label="Band">
          <select name="bandId" required value={bandId} onChange={(e) => setBandId(e.target.value)}>
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
      {/* What's sent is what's shown (the form resets itself after each add, but this stays). */}
      <input type="hidden" name="kind" value={kind} />
      <Field label="What it was">
        <select ref={kindSelect} value={kind} onChange={(e) => setKind(e.target.value)}>
          {MANUAL_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Currency">
        <input name="currency" required defaultValue={currency} maxLength={3} className="uppercase" />
      </Field>
      {kind === "merch" ? (
        // A new band's list starts empty.
        <div key={bandId} className="overflow-x-auto sm:col-span-3">
          <table className="data">
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Each</th>
                <th className="num">Sold</th>
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.value}>
                  <td>{m.label}</td>
                  <td className="num">
                    <input name={`each:${m.value}`} inputMode="decimal" defaultValue={m.price?.toFixed(2) ?? ""} aria-label={`${m.label}: price each`} className="!w-24 text-right" />
                  </td>
                  <td className="num">
                    <input name={`sold:${m.value}`} type="number" min={0} placeholder="0" aria-label={`${m.label}: how many sold`} className="!w-20 text-right" />
                  </td>
                </tr>
              ))}
              <tr>
                <td>
                  <input name="name:other" maxLength={200} placeholder="Something else" aria-label="Something else: what it was" />
                </td>
                <td className="num">
                  <input name="each:other" inputMode="decimal" aria-label="Something else: price each" className="!w-24 text-right" />
                </td>
                <td className="num">
                  <input name="sold:other" type="number" min={0} placeholder="0" aria-label="Something else: how many sold" className="!w-20 text-right" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <Field label="Description" className="sm:col-span-3">
            <input name="itemName" required maxLength={200} />
          </Field>
          <Field label="Amount received">
            <input name="amount" required inputMode="decimal" />
          </Field>
          <Field label="Quantity">
            <input name="quantity" type="number" min={1} defaultValue={1} />
          </Field>
        </>
      )}
    </>
  );
}
