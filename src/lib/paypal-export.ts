import Papa from "papaparse";
import { centsToDecimal } from "./money";

export type PayoutLine = {
  personName: string;
  email: string | null;
  paypalMe: string | null;
  currency: string;
  amountCents: number;
  /** Shown to the recipient, e.g. "Label payout Jan–Mar 2026: Band A, Band B". */
  note: string;
  /** Your own reference, e.g. "P3-7" (period 3, person 7). Max 30 chars for PayPal. */
  referenceId: string;
};

/** Accepts "name", "@name", "paypal.me/name" or a full URL and returns just the handle. */
export function cleanPaypalMeHandle(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^(www\.)?paypal\.me\//i, "")
    .replace(/^@/, "")
    .split(/[/?#]/)[0];
}

/** https://paypal.me/<handle>/<amount><CUR>: opens PayPal with the amount and currency pre-filled. */
export function paypalMeLink(handle: string, amountCents: number, currency: string): string {
  return `https://paypal.me/${encodeURIComponent(cleanPaypalMeHandle(handle))}/${centsToDecimal(amountCents)}${currency.toUpperCase()}`;
}

/** Accepts "name", "@name" or a venmo.com URL and returns just the username. */
export function cleanVenmoHandle(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^(www\.|account\.)?venmo\.com\/(u\/)?/i, "")
    .replace(/^@/, "")
    .split(/[/?#]/)[0];
}

/** Accepts "name", "$name" or a cash.app URL and returns the cashtag without the "$". */
export function cleanCashtag(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^(www\.)?cash\.app\//i, "")
    .replace(/^\$/, "")
    .split(/[/?#]/)[0];
}

/** Venmo's pay screen with the recipient, amount and note filled in. Venmo is US dollars only. */
export function venmoLink(handle: string, amountCents: number, currency: string, note: string): string | null {
  if (currency.toUpperCase() !== "USD") return null;
  const q = new URLSearchParams({ txn: "pay", recipients: cleanVenmoHandle(handle), amount: centsToDecimal(amountCents), note });
  return `https://venmo.com/?${q}`;
}

/** Cash App's pay screen with the amount filled in (US dollars or pounds). */
export function cashAppLink(tag: string, amountCents: number, currency: string): string | null {
  if (!["USD", "GBP"].includes(currency.toUpperCase())) return null;
  return `https://cash.app/$${encodeURIComponent(cleanCashtag(tag))}/${centsToDecimal(amountCents)}`;
}

/** "paypal.me/sam · venmo @sam · $sam": the one-click ways someone can be paid, or null. */
export function payHandlesSummary(p: { paypalMe: string | null; venmo: string | null; cashtag: string | null }): string | null {
  const parts = [p.paypalMe && `paypal.me/${p.paypalMe}`, p.venmo && `venmo @${p.venmo}`, p.cashtag && `$${p.cashtag}`].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export type PayMethod = { kind: "paypal_me" | "venmo" | "cash_app"; label: string; url: string };

/** Every one-click way to pay someone this amount, best first: PayPal.me, then Venmo, then Cash App. */
export function payMethods(
  person: { paypalMe: string | null; venmo: string | null; cashtag: string | null },
  amountCents: number,
  currency: string,
  note: string,
): PayMethod[] {
  const out: PayMethod[] = [];
  if (person.paypalMe) out.push({ kind: "paypal_me", label: "PayPal.me", url: paypalMeLink(person.paypalMe, amountCents, currency) });
  const venmo = person.venmo && venmoLink(person.venmo, amountCents, currency, note);
  if (venmo) out.push({ kind: "venmo", label: "Venmo", url: venmo });
  const cash = person.cashtag && cashAppLink(person.cashtag, amountCents, currency);
  if (cash) out.push({ kind: "cash_app", label: "Cash App", url: cash });
  return out;
}

/**
 * CSV for PayPal Payouts' web upload ("Payouts" → "Upload file", Business accounts).
 * Columns, no header row: recipient email, amount, currency, reference ID, note, recipient wallet.
 * Only positive amounts to people with an email are included.
 */
export function paypalBulkCsv(lines: PayoutLine[]): string {
  const rows = lines
    .filter((l) => l.email && l.amountCents > 0)
    .map((l) => [
      l.email!,
      centsToDecimal(l.amountCents),
      l.currency.toUpperCase(),
      l.referenceId.slice(0, 30),
      l.note.slice(0, 4000),
      "PayPal",
    ]);
  return Papa.unparse(rows, { newline: "\r\n" }) + "\r\n";
}

export function skippedFromBulk(lines: PayoutLine[]): { line: PayoutLine; reason: string }[] {
  return lines
    .filter((l) => !l.email || l.amountCents <= 0)
    .map((line) => ({ line, reason: !line.email ? "No PayPal email" : "Amount is zero or negative" }));
}
