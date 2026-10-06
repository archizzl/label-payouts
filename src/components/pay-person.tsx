"use client";

import { useState } from "react";
import { payMethods } from "@/lib/paypal-export";
import { buttonClass } from "./ui";

export type Payee = { id: number; name: string; paypalMe: string | null; venmo: string | null; cashtag: string | null };

/**
 * On the send-out form: pick someone from People to send label money to directly. Their name fills
 * "Sent to", and a button per way they can be paid opens that app with the amount and note filled
 * in, and records the send-out at the same time.
 */
export function PayPerson({ people, defaultPersonId }: { people: Payee[]; defaultPersonId: number | null }) {
  const [personId, setPersonId] = useState<number | null>(defaultPersonId);
  const person = people.find((p) => p.id === personId) ?? null;
  const ways = person ? payMethods(person, 100, "USD", "").map((m) => m) : [];

  const choose = (select: HTMLSelectElement) => {
    const id = Number(select.value) || null;
    const next = people.find((p) => p.id === id);
    const recipient = select.form?.elements.namedItem("recipient") as HTMLInputElement | null;
    // Fill "Sent to" if it's empty or still has the previously chosen person's name.
    if (recipient && next && (!recipient.value || recipient.value === person?.name)) recipient.value = next.name;
    setPersonId(id);
  };

  const pay = (button: HTMLButtonElement, kind: string, label: string) => {
    const form = button.form;
    if (!form || !person) return;
    const value = (name: string) => (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null)?.value ?? "";
    const cents = Math.round(Number.parseFloat(value("amount").replace(/[^0-9.]/g, "")) * 100);
    if (!(cents > 0)) {
      (form.elements.namedItem("amount") as HTMLInputElement | null)?.focus();
      return;
    }
    const currency = value("currency") || "USD";
    const note = value("note") || [value("source"), "from the label"].filter(Boolean).join(" ");
    const method = payMethods(person, cents, currency, note).find((m) => m.kind === kind);
    if (!method) return;
    window.open(method.url, "_blank", "noopener");
    const how = form.elements.namedItem("method") as HTMLInputElement | null;
    if (how && !how.value) how.value = label;
    form.requestSubmit();
  };

  return (
    <div className="sm:col-span-3">
      <div className="grid gap-4 sm:grid-cols-3">
        <label>
          <span className="mb-1 block text-sm">Pay a person (optional)</span>
          <select name="personId" value={personId ?? ""} onChange={(e) => choose(e.currentTarget)}>
            <option value="">Someone outside the label</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {person && (
          <div className="flex flex-wrap items-end gap-2 sm:col-span-2">
            {ways.length ? (
              ways.map((m) => (
                <button key={m.kind} type="button" className={buttonClass("secondary")} onClick={(e) => pay(e.currentTarget, m.kind, m.label)}>
                  Pay with {m.label} &amp; record it
                </button>
              ))
            ) : (
              <span className="pb-2 text-sm text-muted">
                {person.name} has no PayPal.me, Venmo or Cash App saved. Add one on the People page, or pay them another way and record it.
              </span>
            )}
          </div>
        )}
      </div>
      {person && ways.length > 0 && (
        <p className="mt-1 text-xs text-muted">Opens the app with the amount and note filled in, and records this send-out. Venmo is US dollars only.</p>
      )}
    </div>
  );
}
