/** Parse a money string like "$1,234.56", "-3.10", "€12,00" into integer cents. */
export function parseCents(input: string | number | null | undefined): number {
  if (input === null || input === undefined) return 0;
  if (typeof input === "number") return Math.round(input * 100);
  let s = input.trim();
  if (!s) return 0;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.includes("-")) negative = true;
  s = s.replace(/[^0-9.,]/g, "");
  // "1.234,56" or "12,00" → decimal comma
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot && s.length - lastComma - 1 <= 2) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  const cents = Math.round(n * 100);
  return negative ? -cents : cents;
}

export function formatCents(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** "12.34" — plain decimal string, for CSV exports and PayPal links. */
export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Split `total` cents across weighted recipients using largest-remainder rounding,
 * so the parts always sum exactly to `total`. Works for negative totals (refunds).
 * Weights can be any non-negative numbers (basis points, fractions…).
 */
export function allocate<K>(total: number, weights: { key: K; weight: number }[]): { key: K; cents: number }[] {
  const positive = weights.filter((w) => w.weight > 0);
  const sum = positive.reduce((a, w) => a + w.weight, 0);
  if (positive.length === 0 || sum <= 0) return [];
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const raw = positive.map((w, i) => {
    const exact = (abs * w.weight) / sum;
    const floor = Math.floor(exact);
    return { i, key: w.key, floor, rem: exact - floor };
  });
  let leftover = abs - raw.reduce((a, r) => a + r.floor, 0);
  const order = [...raw].sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const r of order) {
    if (leftover <= 0) break;
    r.floor += 1;
    leftover -= 1;
  }
  return raw.map((r) => ({ key: r.key, cents: sign * r.floor }));
}
