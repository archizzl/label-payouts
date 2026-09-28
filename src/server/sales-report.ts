import "server-only";
import { db, schema } from "@/db";
import { parseCents } from "@/lib/money";
import { computePeriod, salePackage, type SaleRow } from "./data";

/** Columns in a Bandcamp sales report that we read fees from, by any name Bandcamp has used. */
const RAW = {
  gross: ["item total"],
  subTotal: ["sub total", "subtotal"],
  shipping: ["shipping"],
  fanExtra: ["additional fan contribution"],
  processorFee: ["transaction fee", "payment processor fee"],
  bandcampShare: ["bandcamp revenue share", "revenue share", "bandcamp share", "bandcamp fee"],
  marketplaceTax: ["marketplace tax"],
  sellerTax: ["seller tax"],
  source: ["referer", "referrer", "source"],
} as const;

function rawCents(raw: Record<string, string>, keys: readonly string[]): number | null {
  for (const k of keys) if (raw[k] !== undefined && raw[k] !== "") return parseCents(raw[k]);
  return null;
}

/** "bandcamp.com/discover" → "Bandcamp Discover"; blank → "Direct / unknown". */
export function describeSource(raw: Record<string, string>): string {
  const v = (RAW.source.map((k) => raw[k]).find(Boolean) ?? "").trim().toLowerCase();
  if (!v) return "Direct / unknown";
  if (v.includes("discover")) return "Bandcamp Discover";
  if (v.includes("bandcamp daily")) return "Bandcamp Daily";
  if (v.includes("app")) return "Bandcamp app";
  if (v.includes("bandcamp")) return "Bandcamp";
  if (v.includes("google")) return "Google";
  if (v.includes("instagram")) return "Instagram";
  if (v.includes("facebook") || v.includes("fb.")) return "Facebook";
  if (v.includes("twitter") || v === "x" || v.includes("t.co")) return "X / Twitter";
  if (v.includes("tiktok")) return "TikTok";
  if (v.includes("reddit")) return "Reddit";
  if (v.includes("email") || v.includes("mail")) return "Email";
  return v.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
}

export type SalesScope = { bandId?: number; releaseId?: number; from?: string; to?: string };

export type SalesItem = {
  releaseId: number | null;
  title: string;
  kind: "album" | "track" | "merch" | "unmatched";
  artUrl: string | null;
  units: number;
  /** What fans paid for digital (album/track) and physical/merch, before fees. */
  digitalGross: number;
  physicalGross: number;
  gross: number;
  /** Bandcamp's share + payment processing + tax Bandcamp remitted: gross − feesAndTax = net. */
  feesAndTax: number;
  net: number;
  toPeople: number;
};

export type SalesReport = {
  currency: string | null;
  /** Other currencies present but not shown (charts use one currency; no conversion). */
  otherCurrencies: { currency: string; net: number }[];
  saleCount: number;
  units: number;
  gross: number;
  fanExtra: number;
  shipping: number;
  bandcampShare: number;
  processorFee: number;
  marketplaceTax: number;
  net: number;
  label: number;
  bandFund: number;
  costs: number;
  toPeople: number;
  unallocated: number;
  byMonth: { month: string; net: number; units: number }[];
  byFormat: { key: string; net: number; units: number }[];
  bySource: { key: string; net: number; units: number }[];
  items: SalesItem[];
};

/** What the sale was, as a fan would say it: "Digital album", "Vinyl LP", "T-Shirt/Shirt"… */
function formatOf(s: SaleRow, packages: (typeof schema.releases.$inferSelect)["packages"]): string {
  if (s.category === "album") return "Digital album";
  if (s.category === "track") return "Digital track";
  if (s.itemType.includes("refund")) return "Refunds";
  if (s.category !== "merch") return "Other";
  const { pkg } = salePackage(s, packages);
  return pkg?.typeName ?? (s.packageName || "Merch");
}

export function salesReport(scope: SalesScope): SalesReport {
  const { results, saleById } = computePeriod(scope.from ?? "0000-01-01", scope.to ?? "9999-12-31");
  const releases = new Map(db.select().from(schema.releases).all().map((r) => [r.id, r]));

  const inScope = results.filter((r) => {
    const s = saleById.get(r.saleId)!;
    if (scope.releaseId !== undefined) return s.releaseId === scope.releaseId;
    if (scope.bandId !== undefined) return s.bandId === scope.bandId;
    return true;
  });

  // One currency per report (the biggest); others are listed, never mixed or converted.
  const netByCurrency = new Map<string, number>();
  for (const r of inScope) netByCurrency.set(r.currency, (netByCurrency.get(r.currency) ?? 0) + r.netCents);
  const currencies = [...netByCurrency].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const currency = currencies[0]?.[0] ?? null;
  const rows = inScope.filter((r) => r.currency === currency);

  const report: SalesReport = {
    currency,
    otherCurrencies: currencies.slice(1).map(([c, net]) => ({ currency: c, net })),
    saleCount: rows.length,
    units: 0,
    gross: 0,
    fanExtra: 0,
    shipping: 0,
    bandcampShare: 0,
    processorFee: 0,
    marketplaceTax: 0,
    net: 0,
    label: 0,
    bandFund: 0,
    costs: 0,
    toPeople: 0,
    unallocated: 0,
    byMonth: [],
    byFormat: [],
    bySource: [],
    items: [],
  };
  const months = new Map<string, { net: number; units: number }>();
  const formats = new Map<string, { net: number; units: number }>();
  const sources = new Map<string, { net: number; units: number }>();
  const items = new Map<string, SalesItem>();

  for (const r of rows) {
    const s = saleById.get(r.saleId)!;
    const sign = Math.sign(r.netCents) || 1;
    const units = Math.max(1, s.quantity) * sign;
    const net = r.netCents;
    const processor = Math.abs(rawCents(s.raw, RAW.processorFee) ?? 0) * sign;
    const marketplaceTax = Math.abs(rawCents(s.raw, RAW.marketplaceTax) ?? 0) * sign;
    const grossRaw =
      rawCents(s.raw, RAW.gross) ??
      (rawCents(s.raw, RAW.subTotal) ?? net + processor) + (rawCents(s.raw, RAW.shipping) ?? 0) + (rawCents(s.raw, RAW.fanExtra) ?? 0);
    const gross = Math.abs(grossRaw) * sign;
    // Bandcamp's share: its own column if the report has one, otherwise what's left over.
    const explicitShare = rawCents(s.raw, RAW.bandcampShare);
    const bandcampShare =
      explicitShare !== null ? Math.abs(explicitShare) * sign : sign * Math.max(0, Math.abs(gross) - Math.abs(net) - Math.abs(processor) - Math.abs(marketplaceTax));

    report.units += units;
    report.gross += gross;
    report.fanExtra += rawCents(s.raw, RAW.fanExtra) ?? 0; // refund rows already carry a negative amount
    report.shipping += Math.abs(rawCents(s.raw, RAW.shipping) ?? 0) * sign;
    report.processorFee += processor;
    report.marketplaceTax += marketplaceTax;
    report.bandcampShare += bandcampShare;
    report.net += net;
    for (const d of r.deductions) {
      if (d.destination === "label") report.label += d.cents;
      else if (d.destination === "band_fund") report.bandFund += d.cents;
      else if (d.destination === "expense") report.costs += d.cents;
    }
    const people = r.shares.reduce((a, x) => a + x.cents, 0);
    report.toPeople += people;
    report.unallocated += r.unallocatedCents;

    const bump = (m: Map<string, { net: number; units: number }>, key: string) => {
      const e = m.get(key) ?? { net: 0, units: 0 };
      e.net += net;
      e.units += units;
      m.set(key, e);
    };
    const release = s.releaseId ? releases.get(s.releaseId) : undefined;
    bump(months, s.date.slice(0, 7));
    bump(formats, formatOf(s, release?.packages ?? []));
    bump(sources, describeSource(s.raw));

    const key = release ? `r${release.id}` : `u:${s.itemName}`;
    const item = items.get(key) ?? {
      releaseId: release?.id ?? null,
      title: release?.title ?? s.itemName,
      kind: release ? (release.kind === "merch" ? "merch" : release.kind) : "unmatched",
      artUrl: release?.artUrl ?? null,
      units: 0,
      digitalGross: 0,
      physicalGross: 0,
      gross: 0,
      feesAndTax: 0,
      net: 0,
      toPeople: 0,
    };
    item.units += units;
    item.net += net;
    item.gross += gross;
    // Whatever separates what fans paid from what was received, so each row adds up.
    item.feesAndTax += gross - net;
    item.toPeople += people;
    if (s.category === "merch") item.physicalGross += gross;
    else item.digitalGross += gross;
    items.set(key, item);
  }

  // Every month in range, including quiet ones, so gaps show as gaps.
  const monthKeys = [...months.keys()].sort();
  if (monthKeys.length) {
    let [y, m] = monthKeys[0].split("-").map(Number);
    const [ey, em] = monthKeys[monthKeys.length - 1].split("-").map(Number);
    while (y < ey || (y === ey && m <= em)) {
      const k = `${y}-${String(m).padStart(2, "0")}`;
      report.byMonth.push({ month: k, ...(months.get(k) ?? { net: 0, units: 0 }) });
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }
  }
  const sorted = (m: Map<string, { net: number; units: number }>) =>
    [...m].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.net - a.net);
  report.byFormat = sorted(formats);
  report.bySource = sorted(sources);
  report.items = [...items.values()].sort((a, b) => b.net - a.net);
  return report;
}
