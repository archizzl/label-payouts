import Papa from "papaparse";
import { parseCents } from "./money";

/** A normalized row from a Bandcamp sales report. */
export type ParsedSale = {
  /** Stable key for de-duplicating across overlapping imports. */
  dedupeKey: string;
  date: string; // ISO yyyy-mm-dd
  itemType: string; // raw Bandcamp item type, lower-cased ("album", "track", "package", …)
  category: ItemCategory;
  itemName: string;
  artist: string;
  itemUrl: string;
  packageName: string;
  catalogNumber: string;
  isrc: string;
  upc: string;
  quantity: number;
  currency: string;
  netCents: number;
  transactionId: string;
  raw: Record<string, string>;
};

export type ItemCategory = "album" | "track" | "merch" | "other";

export const ITEM_CATEGORIES: { value: ItemCategory; label: string }[] = [
  { value: "album", label: "Digital albums" },
  { value: "track", label: "Digital tracks" },
  { value: "merch", label: "Merch / physical" },
  { value: "other", label: "Other" },
];

export type ParseResult = {
  sales: ParsedSale[];
  skipped: { row: number; reason: string }[];
  headers: string[];
  missingColumns: string[];
};

/** Canonical field → header names Bandcamp has used for it (normalized: lower-case, single spaces). */
const COLUMN_ALIASES = {
  date: ["date", "sale date", "transaction date"],
  itemType: ["item type", "type"],
  itemName: ["item name", "item", "title"],
  artist: ["artist", "band", "artist name"],
  itemUrl: ["item url", "url"],
  packageName: ["package"],
  catalogNumber: ["catalog number", "catalog #", "cat number"],
  isrc: ["isrc"],
  upc: ["upc", "upc/ean", "ean"],
  quantity: ["quantity", "qty"],
  currency: ["currency"],
  net: ["net amount", "amount you received", "net"],
  itemTotal: ["item total", "sub total"],
  transactionId: ["bandcamp transaction id", "transaction id"],
  paypalTransactionId: ["paypal transaction id"],
} as const;

type Field = keyof typeof COLUMN_ALIASES;

const REQUIRED: Field[] = ["date", "itemType", "itemName", "net"];

/** Buyer / shipping PII is dropped before we store the raw row. */
const PII_PREFIXES = ["buyer", "ship to", "ship notes", "fan "];

const SKIP_TYPES = new Set(["payout", "transfer", "withdrawal", "balance", "total", "subtotal"]);

export function normalizeHeader(h: string): string {
  return h.replace(/^﻿/, "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Decode raw file bytes: Bandcamp exports are often UTF-16LE with a BOM. */
export function decodeCsvBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  // UTF-16LE without BOM: lots of zero bytes in odd positions
  if (bytes.length >= 4 && bytes[1] === 0 && bytes[3] === 0 && bytes[0] !== 0) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  return text.replace(/^﻿/, "");
}

export function categorize(itemType: string): ItemCategory {
  const t = itemType.toLowerCase();
  if (t === "album" || t === "bundle" || t.includes("album") || t.includes("discography")) return "album";
  if (t === "track" || t.includes("track")) return "track";
  if (t === "package" || t.includes("merch") || t.includes("physical") || t.includes("package")) return "merch";
  return "other";
}

/**
 * Parse Bandcamp dates. Seen formats: "1/15/24 3:05pm", "01/15/2024 15:05", "2024-01-15 15:05:00",
 * and from the API "15 Jan 2024 15:05:00 GMT".
 * Returns ISO yyyy-mm-dd, or null if unparseable.
 */
export function parseBandcampDate(s: string): string | null {
  const v = s.trim();
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return iso(y, +m[1], +m[2]);
  }
  // The API's "13 May 2026 21:28:01 GMT": take the day as written, like the CSV's clock time.
  m = v.match(/^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})/);
  const month = m && MONTHS.indexOf(m[2].toLowerCase()) + 1;
  if (m && month) return iso(+m[3], month, +m[1]);
  const t = Date.parse(v);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  return null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function parseBandcampCsv(input: string | Uint8Array): ParseResult {
  const text = typeof input === "string" ? input.replace(/^\uFEFF/, "") : decodeCsvBytes(input);
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: "greedy", delimiter: "" });
  const rows = parsed.data;
  if (rows.length === 0) return { sales: [], skipped: [], headers: [], missingColumns: [...REQUIRED] };
  return parseBandcampTable(rows[0], rows.slice(1));
}

/**
 * Rows from the Bandcamp sales API (/api/sales/4/sales_report, format json). Its fields are the CSV
 * columns in snake_case, so they go through the same parser and produce the same de-duplication
 * keys as a downloaded CSV: syncing and importing the same sales never counts them twice.
 */
export function parseBandcampApiReport(report: Record<string, unknown>[]): ParseResult {
  const keys = [...new Set(report.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return parseBandcampTable(
    keys.map((k) => k.replace(/_/g, " ")),
    report.map((r) => keys.map((k) => cell(r[k]))),
  );
}

function parseBandcampTable(headerRow: string[], body: string[][]): ParseResult {
  const rows = [headerRow, ...body];
  const headers = rows[0].map(normalizeHeader);
  const index: Partial<Record<Field, number>> = {};
  for (const field of Object.keys(COLUMN_ALIASES) as Field[]) {
    for (const alias of COLUMN_ALIASES[field]) {
      const i = headers.indexOf(alias);
      if (i !== -1) {
        index[field] = i;
        break;
      }
    }
  }
  const missingColumns = REQUIRED.filter((f) => index[f] === undefined);
  if (missingColumns.length) return { sales: [], skipped: [], headers, missingColumns };

  const get = (row: string[], f: Field) => {
    const i = index[f];
    return i === undefined ? "" : (row[i] ?? "").trim();
  };

  const sales: ParsedSale[] = [];
  const skipped: ParseResult["skipped"] = [];
  const seen = new Map<string, number>();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const rowNum = r + 1;
    const itemType = get(row, "itemType").toLowerCase();
    if (!itemType) {
      skipped.push({ row: rowNum, reason: "No item type (summary or blank row)" });
      continue;
    }
    if (SKIP_TYPES.has(itemType)) {
      skipped.push({ row: rowNum, reason: `Not a sale (${itemType})` });
      continue;
    }
    const date = parseBandcampDate(get(row, "date"));
    if (!date) {
      skipped.push({ row: rowNum, reason: `Unreadable date "${get(row, "date")}"` });
      continue;
    }
    const netRaw = get(row, "net") || get(row, "itemTotal");
    let netCents = parseCents(netRaw);
    // Refund rows are sometimes reported with a positive amount and a "refund" type.
    if (itemType.includes("refund") && netCents > 0) netCents = -netCents;

    const raw: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (!h || PII_PREFIXES.some((p) => h.startsWith(p))) return;
      const v = (row[i] ?? "").trim();
      if (v) raw[h] = v;
    });

    const transactionId = get(row, "transactionId") || get(row, "paypalTransactionId");
    const itemUrl = get(row, "itemUrl");
    const itemName = get(row, "itemName");
    const packageName = get(row, "packageName");
    const baseKey = transactionId
      ? [transactionId, itemType, itemUrl, itemName, packageName, netCents].join("|")
      : [date, get(row, "date"), itemType, itemUrl, itemName, packageName, get(row, "artist"), netCents].join("|");
    // Identical rows inside one file (e.g. same item bought twice in one cart) stay distinct.
    const n = (seen.get(baseKey) ?? 0) + 1;
    seen.set(baseKey, n);

    sales.push({
      dedupeKey: `${baseKey}#${n}`,
      date,
      itemType,
      category: categorize(itemType),
      itemName,
      artist: get(row, "artist"),
      itemUrl,
      packageName,
      catalogNumber: get(row, "catalogNumber"),
      isrc: get(row, "isrc"),
      upc: get(row, "upc"),
      quantity: Number.parseInt(get(row, "quantity"), 10) || 1,
      currency: (get(row, "currency") || "USD").toUpperCase(),
      netCents,
      transactionId,
      raw,
    });
  }

  return { sales, skipped, headers, missingColumns };
}
