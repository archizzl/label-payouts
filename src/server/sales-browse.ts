import "server-only";
import { and, asc, desc, eq, gte, ilike, isNull, lt, lte, or, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db, schema } from "@/db";
import { buildTrend, type Trend } from "@/lib/chart-data";
import { emailFingerprint } from "./secrets";

/*
 * The Sales tab: every imported sale, filtered and sorted from the URL, with totals and breakdowns
 * of exactly what's filtered. Everything is computed in the database, so it stays quick with years
 * of sales.
 */

const { sales, bands, releases, periods, payouts, fans } = schema;

/** A buyer's fingerprint (see emailFingerprint), or null if it can't be made. */
function fingerprint(email: string) {
  try {
    return emailFingerprint(email);
  } catch {
    return null;
  }
}

const CATEGORIES = ["album", "track", "merch", "other"] as const;
export const SORTS = ["date", "item", "band", "type", "country", "source", "qty", "net", "payout"] as const;
export const PAYOUT_STATES = ["paid", "pending", "none"] as const;
export type PayoutState = (typeof PAYOUT_STATES)[number];
export type SortKey = (typeof SORTS)[number];

export type SalesFilter = {
  q?: string;
  from?: string;
  to?: string;
  /** A band id, or "none" for sales not matched to a band. */
  band?: number | "none";
  release?: number;
  type?: (typeof CATEGORIES)[number];
  country?: string;
  source?: string;
  currency?: string;
  refunds?: boolean;
  /** One buyer's sales: their email fingerprint (from a sale's "all sales to this buyer" link). */
  buyer?: string;
  /** paid: in a payout that's been paid; pending: in a finalized payout not paid yet; none: in no payout yet. */
  payout?: PayoutState;
  sort: SortKey;
  dir: "asc" | "desc";
  page: number;
  /** Rows per page. */
  per: number;
};

/** Rows per page: the choices offered, and the default. Any number from 5 to 500 works in the URL. */
export const PAGE_SIZES = [10, 25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 10;

const isoDate = (s: unknown) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined);
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

/** Read the filters from the page's search params (anything unrecognised is ignored). */
export function parseSalesFilter(sp: Record<string, string | string[] | undefined>): SalesFilter {
  const band = one(sp.band);
  const type = one(sp.type);
  const sort = one(sp.sort);
  return {
    q: one(sp.q),
    from: isoDate(one(sp.from)),
    to: isoDate(one(sp.to)),
    band: band === "none" ? "none" : Number(band) || undefined,
    release: Number(one(sp.release)) || undefined,
    type: CATEGORIES.find((c) => c === type),
    country: one(sp.country),
    source: one(sp.source),
    currency: one(sp.currency)?.toUpperCase(),
    refunds: one(sp.refunds) === "1",
    buyer: one(sp.buyer)?.replace(/[^A-Za-z0-9_-]/g, "") || undefined,
    payout: PAYOUT_STATES.find((p) => p === one(sp.payout)),
    sort: SORTS.find((s) => s === sort) ?? "date",
    dir: one(sp.dir) === "asc" ? "asc" : "desc",
    page: Math.max(1, Number.parseInt(one(sp.page) ?? "1", 10) || 1),
    per: Math.min(500, Math.max(5, Number.parseInt(one(sp.per) ?? "", 10) || DEFAULT_PAGE_SIZE)),
  };
}

/** The same filters as URL params, minus the defaults, with some changed. */
export function filterQuery(f: SalesFilter, change: Partial<Record<keyof SalesFilter, string | number | boolean | undefined>> = {}) {
  const merged: Record<string, unknown> = { ...f, ...change };
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === "" || v === false) continue;
    if (k === "sort" && v === "date") continue;
    if (k === "dir" && v === "desc") continue;
    if (k === "page" && v === 1) continue;
    if (k === "per" && v === DEFAULT_PAGE_SIZE) continue;
    p.set(k, v === true ? "1" : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

const country = sql<string>`coalesce(nullif(${sales.raw}->>'country', ''), '')`;
const source = sql<string>`coalesce(nullif(${sales.raw}->>'referer', ''), nullif(${sales.raw}->>'referrer', ''), nullif(${sales.raw}->>'source', ''), '')`;
/*
 * The finalized payout that paid a sale, the same rule payouts use: the one whose list has it (or,
 * for payouts without a list, one for the whole label or the sale's band whose dates include it). It counts as paid once every person in it is
 * marked paid (or kept, for whoever holds the label's account).
 */
const coveringPeriod = sql`coalesce(
  (select ps.period_id from ${schema.periodSales} ps where ps.org_id = ${sales.orgId} and ps.dedupe_key = ${sales.dedupeKey} limit 1),
  (select ${periods.id} from ${periods}
    where ${periods.orgId} = ${sales.orgId} and ${sales.date} between ${periods.startDate} and ${periods.endDate}
      and (${periods.bandId} is null or ${periods.bandId} = ${sales.bandId})
      and not exists (select 1 from ${schema.periodSales} x where x.period_id = ${periods.id})
    order by ${periods.id} limit 1))`;
const payoutState = sql<PayoutState>`case
  when ${coveringPeriod} is null then 'none'
  when exists (select 1 from ${payouts} where ${payouts.periodId} = ${coveringPeriod} and ${payouts.status} = 'pending') then 'pending'
  else 'paid' end`;

const like = (s: string) => `%${s.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

function where(orgId: string, f: SalesFilter): SQL {
  const c: (SQL | undefined)[] = [eq(sales.orgId, orgId)];
  if (f.q) {
    const l = like(f.q);
    // A whole email address finds that buyer's sales (by fingerprint: emails aren't stored).
    const buyer = f.q.includes("@") ? fingerprint(f.q) : null;
    c.push(
      or(
        ilike(sales.itemName, l),
        ilike(sales.artist, l),
        ilike(sales.packageName, l),
        ilike(sales.transactionId, l),
        ilike(sales.itemUrl, l),
        buyer ? eq(sales.buyerKey, buyer) : undefined,
      ),
    );
  }
  if (f.buyer) c.push(eq(sales.buyerKey, f.buyer));
  if (f.from) c.push(gte(sales.date, f.from));
  if (f.to) c.push(lte(sales.date, f.to));
  if (f.band === "none") c.push(isNull(sales.bandId));
  else if (f.band) c.push(eq(sales.bandId, f.band));
  if (f.release) c.push(eq(sales.releaseId, f.release));
  if (f.type) c.push(eq(sales.category, f.type));
  if (f.country !== undefined) c.push(sql`${country} = ${f.country === "(none)" ? "" : f.country}`);
  if (f.source !== undefined) c.push(sql`${source} = ${f.source === "(direct)" ? "" : f.source}`);
  if (f.currency) c.push(eq(sales.currency, f.currency));
  if (f.refunds) c.push(lt(sales.netCents, 0));
  if (f.payout) c.push(sql`${payoutState} = ${f.payout}`);
  return and(...c)!;
}

const ORDER: Record<SortKey, SQL | AnyPgColumn> = {
  date: sales.date,
  item: sql`lower(${sales.itemName})`,
  band: sql`lower(coalesce(${bands.name}, ${sales.artist}))`,
  type: sales.category,
  country: sql`nullif(${country}, '')`,
  source: sql`nullif(${source}, '')`,
  qty: sales.quantity,
  net: sales.netCents,
  // Not paid out yet first (ascending), then waiting to be paid, then paid.
  payout: sql`case ${payoutState} when 'none' then 0 when 'pending' then 1 else 2 end`,
};

export type SaleRow = Awaited<ReturnType<typeof browseSales>>["rows"][number];

/** One page of sales, sorted. */
export async function browseSales(orgId: string, f: SalesFilter) {
  const w = where(orgId, f);
  const by = f.dir === "asc" ? asc : desc;
  const [rows, [{ n }]] = await Promise.all([
    db
      .select({
        id: sales.id,
        date: sales.date,
        itemName: sales.itemName,
        itemType: sales.itemType,
        category: sales.category,
        artist: sales.artist,
        packageName: sales.packageName,
        itemUrl: sales.itemUrl,
        quantity: sales.quantity,
        currency: sales.currency,
        netCents: sales.netCents,
        transactionId: sales.transactionId,
        bandId: sales.bandId,
        bandName: bands.name,
        releaseId: sales.releaseId,
        releaseTitle: releases.title,
        country,
        source,
        raw: sales.raw,
        payoutState,
        periodId: coveringPeriod.mapWith(Number),
        buyerKey: sales.buyerKey,
        buyerSales: sql<number>`(select count(*)::int from ${sales} b where b.org_id = ${sales.orgId} and b.buyer_key = ${sales.buyerKey})`,
        // If the buyer is on the mailing list, who they are (they gave the label their details).
        fanEmail: sql<string | null>`(select ${fans.email} from ${fans} where ${fans.orgId} = ${sales.orgId} and ${fans.emailKey} = ${sales.buyerKey} limit 1)`,
        fanName: sql<string | null>`(select ${fans.name} from ${fans} where ${fans.orgId} = ${sales.orgId} and ${fans.emailKey} = ${sales.buyerKey} limit 1)`,
      })
      .from(sales)
      .leftJoin(bands, eq(bands.id, sales.bandId))
      .leftJoin(releases, eq(releases.id, sales.releaseId))
      .where(w)
      // Blanks (no country, no source) go last either way.
      .orderBy(sql`${ORDER[f.sort]} ${sql.raw(f.dir)} nulls last`, by(sales.date), by(sales.id))
      .limit(f.per)
      .offset((f.page - 1) * f.per),
    db.select({ n: sql<number>`count(*)::int` }).from(sales).where(w),
  ]);
  return { rows, count: n };
}

/** Every matching sale (for the CSV export). */
export async function allMatchingSales(orgId: string, f: SalesFilter) {
  return db
    .select({ sale: sales, bandName: bands.name, releaseTitle: releases.title })
    .from(sales)
    .leftJoin(bands, eq(bands.id, sales.bandId))
    .leftJoin(releases, eq(releases.id, sales.releaseId))
    .where(where(orgId, f))
    .orderBy(desc(sales.date), desc(sales.id));
}

type Breakdown = { key: string; net: number; units: number };

/** Totals and breakdowns of everything matching (in each currency; nothing is converted). */
export async function summarizeSales(orgId: string, f: SalesFilter) {
  const w = where(orgId, f);
  const units = sql<number>`sum(greatest(1, ${sales.quantity}) * sign(${sales.netCents}))::int`;
  const net = sql<number>`sum(${sales.netCents})::int`;
  const group = (key: SQL<string>, limit = 8) =>
    db
      .select({ currency: sales.currency, key, net, units })
      .from(sales)
      .leftJoin(bands, eq(bands.id, sales.bandId))
      .where(w)
      .groupBy(sales.currency, sql`2`)
      .orderBy(sql`3 desc`)
      .limit(limit * 4);
  // Month by month per key, for a breakdown's trend line.
  const monthly = (key: SQL<string>) =>
    db
      .select({ currency: sales.currency, month: sql<string>`substr(${sales.date}, 1, 7)`, key, value: net })
      .from(sales)
      .leftJoin(bands, eq(bands.id, sales.bandId))
      .where(w)
      .groupBy(sales.currency, sql`2`, sql`3`);
  const keys = {
    item: sql<string>`${sales.itemName}`,
    country: sql<string>`case when ${country} = '' then 'Not given' else ${country} end`,
    source: sql<string>`case when ${source} = '' then 'Direct / unknown' else ${source} end`,
    type: sql<string>`${sales.category}`,
    band: sql<string>`coalesce(${bands.name}, 'Not matched to a band')`,
  };
  const [trendRows, [totals, byMonth, byItem, byCountry, bySource, byType, byBand, byPayout]] = await Promise.all([
    Promise.all(Object.values(keys).map(monthly)),
    Promise.all([
    db
      .select({
        currency: sales.currency,
        sales: sql<number>`count(*)::int`,
        units,
        net,
        refunds: sql<number>`count(*) filter (where ${sales.netCents} < 0)::int`,
        refundCents: sql<number>`coalesce(sum(${sales.netCents}) filter (where ${sales.netCents} < 0), 0)::int`,
        first: sql<string>`min(${sales.date})`,
        last: sql<string>`max(${sales.date})`,
      })
      .from(sales)
      .where(w)
      .groupBy(sales.currency)
      .orderBy(sql`4 desc`),
    db
      .select({ currency: sales.currency, month: sql<string>`substr(${sales.date}, 1, 7)`, net, units })
      .from(sales)
      .where(w)
      .groupBy(sales.currency, sql`2`)
      .orderBy(sql`2`),
    group(keys.item),
    group(keys.country),
    group(keys.source),
    group(keys.type),
    group(keys.band),
    db
      .select({ currency: sales.currency, state: payoutState, net, sales: sql<number>`count(*)::int` })
      .from(sales)
      .where(w)
      .groupBy(sales.currency, sql`2`),
    ]),
  ]);

  const currencies = totals.map((t) => t.currency);
  const main = currencies[0] ?? "USD";
  const pick = (rows: (Breakdown & { currency: string })[], limit = 8) =>
    rows
      .filter((r) => r.currency === main)
      .slice(0, limit)
      .map(({ key, net, units }) => ({ key, net, units }));
  return {
    main,
    totals,
    byMonth: fillMonths(byMonth.filter((m) => m.currency === main)),
    byItem: pick(byItem),
    byCountry: pick(byCountry),
    bySource: pick(bySource),
    byType: pick(byType),
    byBand: pick(byBand),
    /** Month by month for the biggest few of each breakdown (main currency): their trend lines. */
    trends: Object.fromEntries(
      Object.keys(keys).map((k, i) => [k, buildTrend(trendRows[i].filter((r) => r.currency === main))]),
    ) as Record<keyof typeof keys, Trend>,
    byPayout: Object.fromEntries(
      PAYOUT_STATES.map((st) => {
        const r = byPayout.find((p) => p.currency === main && p.state === st);
        return [st, { net: r?.net ?? 0, sales: r?.sales ?? 0 }];
      }),
    ) as Record<PayoutState, { net: number; sales: number }>,
  };
}

/** Every month between the first and last, so quiet months show as zero. */
function fillMonths(rows: { month: string; net: number; units: number }[]) {
  if (!rows.length) return [];
  const m = new Map(rows.map((r) => [r.month, r]));
  const out: { month: string; net: number; units: number }[] = [];
  let [y, mo] = rows[0].month.split("-").map(Number);
  const last = rows[rows.length - 1].month;
  for (let k = rows[0].month; k <= last && out.length < 600; ) {
    out.push({ month: k, net: m.get(k)?.net ?? 0, units: m.get(k)?.units ?? 0 });
    mo++;
    if (mo > 12) [y, mo] = [y + 1, 1];
    k = `${y}-${String(mo).padStart(2, "0")}`;
  }
  return out;
}

/** Choices for the filter dropdowns. */
export async function salesFilterOptions(orgId: string) {
  const [bandRows, countries, sources, currencies] = await Promise.all([
    db.select({ id: bands.id, name: bands.name }).from(bands).where(eq(bands.orgId, orgId)).orderBy(asc(bands.name)),
    db
      .selectDistinct({ v: country })
      .from(sales)
      .where(eq(sales.orgId, orgId))
      .orderBy(sql`1`),
    db
      .select({ v: source, n: sql<number>`count(*)::int` })
      .from(sales)
      .where(eq(sales.orgId, orgId))
      .groupBy(sql`1`)
      .orderBy(sql`2 desc`)
      .limit(40),
    db
      .selectDistinct({ v: sales.currency })
      .from(sales)
      .where(eq(sales.orgId, orgId)),
  ]);
  return {
    bands: bandRows,
    countries: countries.map((c) => c.v),
    sources: sources.map((s) => s.v),
    currencies: currencies.map((c) => c.v).sort(),
  };
}
