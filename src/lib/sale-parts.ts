import { parseCents } from "./money";

/*
 * Parts of a sale as Bandcamp reports it, which a withholding can take exactly (e.g. "whatever the
 * fan paid above the price"). Only parts inside Bandcamp's net amount, which is what gets split:
 * shipping and sales tax are never in it (shipping stays with the label; tax goes to the
 * government), so they can't be withheld again.
 */

export const SALE_PARTS = [
  { key: "fan_extra", label: "Paid above price", raw: ["additional fan contribution"], hint: "what the fan chose to pay over the price" },
] as const;

export type SalePart = (typeof SALE_PARTS)[number]["key"];

export const isSalePart = (v: unknown): v is SalePart => SALE_PARTS.some((p) => p.key === v);
export const salePartLabel = (key: string | null | undefined) => SALE_PARTS.find((p) => p.key === key)?.label ?? "Part of the sale";

/** Each part's amount on this sale, in cents (always positive; 0 when the report doesn't have it). */
export function salePartsOf(raw: Record<string, string>): Record<SalePart, number> {
  const out = {} as Record<SalePart, number>;
  for (const p of SALE_PARTS) {
    const k = p.raw.find((r) => raw[r] !== undefined && raw[r] !== "");
    out[p.key] = k ? Math.abs(parseCents(raw[k])) : 0;
  }
  return out;
}
