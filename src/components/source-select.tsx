"use client";

/** What picking an income source can fill in on the send-out form. */
export type SourceInfo = {
  label: string;
  bandId: number | null;
  releaseId: number | null;
  /** What's still there from this source (came in minus sent on), in cents, in `currency`. */
  remainingCents: number | null;
  currency: string | null;
  /** From the last time money was sent out of this source. */
  lastRecipient: string | null;
  lastMethod: string | null;
};

/**
 * The "From" dropdown on the send-out form. Choosing a source fills in every blank field it can
 * (band, release, amount still there, currency, recipient and method from last time), never
 * anything already typed.
 */
export function SourceSelect({ sources, defaultValue }: { sources: SourceInfo[]; defaultValue: string }) {
  const fill = (select: HTMLSelectElement) => {
    const s = sources.find((x) => x.label === select.value);
    const form = select.form;
    if (!s || !form) return;
    const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
    const setIfBlank = (name: string, value: string | number | null | undefined) => {
      const el = field(name);
      if (!el || value === null || value === undefined || value === "" || el.value) return;
      // Only choose an option the select actually has.
      if (el instanceof HTMLSelectElement && ![...el.options].some((o) => o.value === String(value))) return;
      el.value = String(value);
    };
    setIfBlank("bandId", s.bandId);
    setIfBlank("releaseId", s.releaseId);
    setIfBlank("recipient", s.lastRecipient);
    setIfBlank("method", s.lastMethod);
    const amount = field("amount");
    if (amount && !amount.value && s.remainingCents && s.remainingCents > 0) {
      amount.value = (s.remainingCents / 100).toFixed(2);
      const currency = field("currency");
      if (currency && s.currency) currency.value = s.currency;
    }
  };
  return (
    <select name="source" defaultValue={defaultValue} onChange={(e) => fill(e.currentTarget)}>
      <option value="">Not tied to a source</option>
      {sources.map((x) => (
        <option key={x.label} value={x.label}>
          {x.label}
          {x.remainingCents ? ` (${(x.remainingCents / 100).toFixed(2)} ${x.currency ?? ""} still there)` : ""}
        </option>
      ))}
    </select>
  );
}
