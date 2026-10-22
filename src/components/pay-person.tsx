"use client";

import { useState } from "react";
import { payMethods } from "@/lib/paypal-export";
import { buttonClass } from "./ui";

export type Payee = { id: number; name: string; paypalMe: string | null; venmo: string | null; cashtag: string | null };

/**
 * On the send-out form, "Sent to": someone in the label (anyone in People: a manager, a PR person, a
 * band member) or someone outside it, by name. Picking a person fills in their name, and a button
 * per way they can be paid opens that app with the amount and note filled in, and records the
 * send-out at the same time.
 */
export function SentTo({ people, defaultPersonId, defaultRecipient }: { people: Payee[]; defaultPersonId: number | null; defaultRecipient?: string }) {
  const [personId, setPersonId] = useState<number | null>(defaultPersonId);
  const person = people.find((p) => p.id === personId) ?? null;
  const ways = person ? payMethods(person, 100, "USD", "") : [];

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
    <div className="space-y-2">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-muted">Sent to</span>
        <select name="personId" value={personId ?? ""} onChange={(e) => setPersonId(Number(e.currentTarget.value) || null)}>
          <option value="">Someone outside the label</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {person ? (
        <>
          <input type="hidden" name="recipient" value={person.name} />
          {ways.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {ways.map((m) => (
                <button key={m.kind} type="button" className={buttonClass("secondary", "sm")} onClick={(e) => pay(e.currentTarget, m.kind, m.label)}>
                  Pay with {m.label} &amp; record it
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted">No PayPal.me, Venmo or Cash App saved for {person.name}.</p>
          )}
        </>
      ) : (
        <input name="recipient" required defaultValue={defaultRecipient} placeholder="Mutual Aid NYC" aria-label="Who received it" />
      )}
    </div>
  );
}
