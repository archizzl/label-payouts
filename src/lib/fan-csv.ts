import Papa from "papaparse";
import { decodeCsvBytes, normalizeHeader, parseBandcampDate } from "./bandcamp-csv";

/*
 * Bandcamp's mailing-list export (Tools → Mailing list → export). Bandcamp doesn't document its
 * columns, so they're matched by name with some leeway: an email column is all that's required;
 * name, country, postal code, sign-up date and the artist/band are used when present, and anything
 * else is kept as is.
 */

export type ParsedFan = {
  email: string;
  name: string | null;
  country: string | null;
  postalCode: string | null;
  /** yyyy-mm-dd, when the file says. */
  addedOn: string | null;
  /** The bands or artists the file says they signed up through, if it has such a column. */
  sources: string[];
  extra: Record<string, string>;
};

export type FanParseResult = {
  fans: ParsedFan[];
  headers: string[];
  /** Rows without a usable email address. */
  skipped: number;
  /** Same email more than once in the file (kept once). */
  repeats: number;
  error?: string;
};

const ALIASES = {
  email: ["email", "email address", "e-mail", "e-mail address", "fan email"],
  name: ["fullname", "full name", "name", "fan name"],
  firstName: ["firstname", "first name", "first"],
  lastName: ["lastname", "last name", "last"],
  country: ["country", "country name"],
  postalCode: ["postal code", "postalcode", "zip", "zip code", "zip/postal code", "postcode"],
  addedOn: ["date added", "date", "added", "signup date", "sign up date", "subscribed", "date subscribed", "join date"],
  source: ["band", "band name", "artist", "artist name"],
};
type Field = keyof typeof ALIASES;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseFanCsv(input: string | Uint8Array): FanParseResult {
  const text = typeof input === "string" ? input.replace(/^﻿/, "") : decodeCsvBytes(input);
  const rows = Papa.parse<string[]>(text, { skipEmptyLines: "greedy", delimiter: "" }).data;
  if (!rows.length) return { fans: [], headers: [], skipped: 0, repeats: 0, error: "The file is empty." };

  const headers = rows[0].map(normalizeHeader);
  const col = {} as Record<Field, number>;
  for (const f of Object.keys(ALIASES) as Field[]) col[f] = headers.findIndex((h) => ALIASES[f].includes(h));
  // No header row we recognise, but the first column holds emails: a bare list.
  const bare = col.email < 0 && EMAIL.test((rows[0][0] ?? "").trim());
  if (col.email < 0 && !bare) {
    return { fans: [], headers, skipped: 0, repeats: 0, error: "Couldn’t find an email column in this file." };
  }
  if (bare) col.email = 0;
  const used = new Set(Object.values(col).filter((i) => i >= 0));

  const seen = new Map<string, ParsedFan>();
  let skipped = 0;
  let repeats = 0;
  for (const row of bare ? rows : rows.slice(1)) {
    const get = (f: Field) => (col[f] >= 0 ? (row[col[f]] ?? "").trim() : "") || null;
    const email = get("email")?.toLowerCase();
    if (!email || !EMAIL.test(email)) {
      skipped++;
      continue;
    }
    const name = get("name") ?? ([get("firstName"), get("lastName")].filter(Boolean).join(" ") || null);
    const added = get("addedOn");
    const extra: Record<string, string> = {};
    if (!bare) headers.forEach((h, i) => !used.has(i) && row[i]?.trim() && (extra[h] = row[i].trim()));
    const fan: ParsedFan = {
      email,
      name,
      country: get("country"),
      postalCode: get("postalCode"),
      addedOn: added ? parseBandcampDate(added) : null,
      sources: get("source") ? [get("source")!] : [],
      extra,
    };
    const before = seen.get(email);
    if (before) {
      repeats++;
      // Keep the earliest sign-up date, and fill in anything the first row lacked.
      if (fan.addedOn && (!before.addedOn || fan.addedOn < before.addedOn)) before.addedOn = fan.addedOn;
      before.name ??= fan.name;
      before.country ??= fan.country;
      before.postalCode ??= fan.postalCode;
      for (const src of fan.sources) if (!before.sources.includes(src)) before.sources.push(src);
      continue;
    }
    seen.set(email, fan);
  }
  return { fans: [...seen.values()], headers, skipped, repeats };
}
