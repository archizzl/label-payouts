import "server-only";
import { and, asc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { ParsedFan } from "@/lib/fan-csv";
import { normalizeText } from "@/lib/routing";
import { emailFingerprint } from "./secrets";

/*
 * The mailing list: fans brought in from Bandcamp's mailing-list export. One row per email per
 * account; a fan can be on several bands' lists (or just the label's).
 */

const { fans, fanBands, fanImports, bands, sales } = schema;

const fingerprint = (email: string) => {
  try {
    return emailFingerprint(email);
  } catch {
    return null; // no APP_ENCRYPTION_KEY: fans just aren't matched to purchases
  }
};

/** Give fans added before purchases were matched their fingerprint. */
async function fillFanKeys(orgId: string) {
  const missing = await db
    .select({ id: fans.id, email: fans.email })
    .from(fans)
    .where(and(eq(fans.orgId, orgId), sql`${fans.emailKey} is null`));
  for (const f of missing) {
    const key = fingerprint(f.email);
    if (key) await db.update(fans).set({ emailKey: key }).where(eq(fans.id, f.id));
  }
}

export type FanImportPlan = {
  total: number;
  fresh: number;
  known: number;
  /** Sources (artist/band names in the file) and the band each matched, if any. */
  sources: { name: string; bandId: number | null; count: number }[];
  dateRange: [string, string] | null;
};

/** Match the file's artist/band names to the account's bands (by name or alias). */
async function bandMatcher(orgId: string) {
  const rows = await db.select().from(bands).where(eq(bands.orgId, orgId));
  return (name: string) => rows.find((b) => [b.name, ...b.aliases].some((n) => normalizeText(n) === normalizeText(name)))?.id ?? null;
}

/** What importing these fans would do, without saving anything. */
export async function planFanImport(orgId: string, parsed: ParsedFan[]): Promise<FanImportPlan> {
  const emails = parsed.map((f) => f.email);
  const existing = emails.length
    ? await db
        .select({ email: fans.email })
        .from(fans)
        .where(and(eq(fans.orgId, orgId), inArray(fans.email, emails)))
    : [];
  const match = await bandMatcher(orgId);
  const counts = new Map<string, number>();
  for (const f of parsed) for (const s of f.sources) counts.set(s, (counts.get(s) ?? 0) + 1);
  const dates = parsed.map((f) => f.addedOn).filter((d): d is string => !!d).sort();
  return {
    total: parsed.length,
    fresh: parsed.length - existing.length,
    known: existing.length,
    sources: [...counts].map(([name, count]) => ({ name, count, bandId: match(name) })).sort((a, b) => b.count - a.count),
    dateRange: dates.length ? [dates[0], dates[dates.length - 1]] : null,
  };
}

/**
 * Save the fans: new ones are added, ones already here get any details they were missing and an
 * earlier sign-up date if the file has one. Each is put on the list of the band the file names
 * for them, or else `bandId` (the band the whole file was exported from; null for the label's own).
 */
export async function importFans(
  orgId: string,
  parsed: ParsedFan[],
  { filename, bandId, userId }: { filename: string; bandId: number | null; userId: string | null },
) {
  const match = await bandMatcher(orgId);
  const today = new Date().toISOString().slice(0, 10);
  return db.transaction(async (tx) => {
    const [imp] = await tx
      .insert(fanImports)
      .values({ orgId, filename, bandId, rowCount: parsed.length, addedCount: 0, importedByUserId: userId })
      .returning();
    let added = 0;
    for (let i = 0; i < parsed.length; i += 500) {
      const chunk = parsed.slice(i, i + 500);
      const saved = await tx
        .insert(fans)
        .values(
          chunk.map((f) => ({
            orgId,
            email: f.email,
            name: f.name,
            country: f.country,
            postalCode: f.postalCode,
            addedOn: f.addedOn ?? today,
            extra: f.extra,
            firstImportId: imp.id,
            emailKey: fingerprint(f.email),
          })),
        )
        .onConflictDoUpdate({
          target: [fans.orgId, fans.email],
          set: {
            name: sql`coalesce(${fans.name}, excluded.name)`,
            country: sql`coalesce(${fans.country}, excluded.country)`,
            postalCode: sql`coalesce(${fans.postalCode}, excluded.postal_code)`,
            addedOn: sql`least(${fans.addedOn}, excluded.added_on)`,
            emailKey: sql`coalesce(${fans.emailKey}, excluded.email_key)`,
          },
        })
        // xmax = 0 only for rows this statement inserted.
        .returning({ id: fans.id, email: fans.email, inserted: sql<boolean>`(xmax = 0)` });
      added += saved.filter((s) => s.inserted).length;
      const idOf = new Map(saved.map((s) => [s.email, s.id]));
      const links = chunk.flatMap((f) => {
        const matched = f.sources.map(match).filter((b): b is number => b !== null);
        const onto = matched.length ? matched : bandId ? [bandId] : [];
        return [...new Set(onto)].map((b) => ({ fanId: idOf.get(f.email)!, bandId: b }));
      });
      if (links.length) await tx.insert(fanBands).values(links).onConflictDoNothing();
    }
    await tx.update(fanImports).set({ addedCount: added }).where(eq(fanImports.id, imp.id));
    return { importId: imp.id, added, updated: parsed.length - added };
  });
}

export type FanFilter = { q?: string; bandId?: number | "label" | null };

function fanWhere(orgId: string, { q, bandId }: FanFilter) {
  const conds = [eq(fans.orgId, orgId)];
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conds.push(or(ilike(fans.email, like), ilike(fans.name, like), ilike(fans.country, like))!);
  }
  if (bandId === "label") conds.push(sql`not exists (select 1 from ${fanBands} where ${fanBands.fanId} = ${fans.id})`);
  else if (bandId) conds.push(sql`exists (select 1 from ${fanBands} where ${fanBands.fanId} = ${fans.id} and ${fanBands.bandId} = ${bandId})`);
  return and(...conds);
}

/** Fans matching a search, newest sign-ups first, each with the bands whose lists they're on. */
export async function listFans(orgId: string, filter: FanFilter, limit = 200) {
  await fillFanKeys(orgId);
  const where = fanWhere(orgId, filter);
  const [rows, [{ n }]] = await Promise.all([
    db
      .select()
      .from(fans)
      .where(where)
      .orderBy(sql`${fans.addedOn} desc`, asc(fans.email))
      .limit(limit),
    db.select({ n: sql<number>`count(*)::int` }).from(fans).where(where),
  ]);
  const links = rows.length
    ? await db
        .select()
        .from(fanBands)
        .where(
          inArray(
            fanBands.fanId,
            rows.map((r) => r.id),
          ),
        )
    : [];
  const bandsOf = new Map<number, number[]>();
  for (const l of links) bandsOf.set(l.fanId, [...(bandsOf.get(l.fanId) ?? []), l.bandId]);
  const bought = await purchasesOf(orgId, rows);
  return { rows: rows.map((r) => ({ ...r, bandIds: bandsOf.get(r.id) ?? [], purchases: bought.get(r.id) ?? [] })), count: n };
}

export type Purchase = { date: string; itemName: string; artist: string; bandId: number | null; currency: string; netCents: number };

/** What each of these fans has bought, newest first (matched by email fingerprint). */
async function purchasesOf(orgId: string, rows: { id: number; emailKey: string | null }[]) {
  const byKey = new Map(rows.filter((r) => r.emailKey).map((r) => [r.emailKey!, r.id]));
  const out = new Map<number, Purchase[]>();
  if (!byKey.size) return out;
  const found = await db
    .select({
      buyerKey: sales.buyerKey,
      date: sales.date,
      itemName: sales.itemName,
      artist: sales.artist,
      bandId: sales.bandId,
      currency: sales.currency,
      netCents: sales.netCents,
    })
    .from(sales)
    .where(and(eq(sales.orgId, orgId), inArray(sales.buyerKey, [...byKey.keys()])))
    .orderBy(sql`${sales.date} desc`);
  for (const { buyerKey, ...p } of found) {
    const id = byKey.get(buyerKey!)!;
    out.set(id, [...(out.get(id) ?? []), p]);
  }
  return out;
}

/** Everything for the export: every matching fan (no limit). */
export async function allFans(orgId: string, filter: FanFilter) {
  return (await listFans(orgId, filter, 1_000_000)).rows;
}

/** Totals for the page: list size, sign-ups by month, per band, top countries. */
export async function fanStats(orgId: string) {
  await fillFanKeys(orgId);
  const onList = sql`exists (select 1 from ${fans} where ${fans.orgId} = ${orgId} and ${fans.emailKey} = ${sales.buyerKey})`;
  const [bandMonths, countryMonths, [[totals], byMonth, byBand, byCountry, imports, [buyers], top]] = await Promise.all([
    // Sign-ups month by month per band and per country, for trend lines.
    db
      .select({ month: sql<string>`substr(${fans.addedOn}, 1, 7)`, bandId: fanBands.bandId, n: sql<number>`count(*)::int` })
      .from(fanBands)
      .innerJoin(fans, eq(fans.id, fanBands.fanId))
      .where(eq(fans.orgId, orgId))
      .groupBy(sql`1`, fanBands.bandId),
    db
      .select({ month: sql<string>`substr(${fans.addedOn}, 1, 7)`, country: sql<string>`coalesce(nullif(${fans.country}, ''), 'Not given')`, n: sql<number>`count(*)::int` })
      .from(fans)
      .where(eq(fans.orgId, orgId))
      .groupBy(sql`1`, sql`2`),
    Promise.all([
    db
      .select({
        total: sql<number>`count(*)::int`,
        last30: sql<number>`count(*) filter (where ${fans.addedOn} >= to_char(now() - interval '30 days', 'YYYY-MM-DD'))::int`,
      })
      .from(fans)
      .where(eq(fans.orgId, orgId)),
    db
      .select({ month: sql<string>`substr(${fans.addedOn}, 1, 7)`, n: sql<number>`count(*)::int` })
      .from(fans)
      .where(eq(fans.orgId, orgId))
      .groupBy(sql`1`)
      .orderBy(sql`1`),
    db
      .select({ bandId: fanBands.bandId, n: sql<number>`count(*)::int` })
      .from(fanBands)
      .innerJoin(fans, eq(fans.id, fanBands.fanId))
      .where(eq(fans.orgId, orgId))
      .groupBy(fanBands.bandId),
    db
      .select({ country: sql<string>`coalesce(${fans.country}, '')`, n: sql<number>`count(*)::int` })
      .from(fans)
      .where(eq(fans.orgId, orgId))
      .groupBy(sql`1`)
      .orderBy(sql`2 desc`),
    db
      .select()
      .from(fanImports)
      .where(eq(fanImports.orgId, orgId))
      .orderBy(sql`${fanImports.id} desc`)
      .limit(10),
    // Buyers (distinct fingerprints), and how many of them are on the list.
    db
      .select({
        known: sql<number>`count(distinct ${sales.buyerKey}) filter (where ${sales.buyerKey} <> '')::int`,
        onList: sql<number>`count(distinct ${sales.buyerKey}) filter (where ${sales.buyerKey} <> '' and ${onList})::int`,
        unchecked: sql<number>`count(*) filter (where ${sales.buyerKey} is null)::int`,
      })
      .from(sales)
      .where(eq(sales.orgId, orgId)),
    // The biggest supporters on the list.
    db
      .select({
        fanId: fans.id,
        email: fans.email,
        name: fans.name,
        currency: sales.currency,
        cents: sql<number>`sum(${sales.netCents})::int`,
        items: sql<number>`count(*)::int`,
      })
      .from(fans)
      .innerJoin(sales, and(eq(sales.orgId, fans.orgId), eq(sales.buyerKey, fans.emailKey)))
      .where(eq(fans.orgId, orgId))
      .groupBy(fans.id, fans.email, fans.name, sales.currency)
      .orderBy(sql`sum(${sales.netCents}) desc`)
      .limit(10),
    ]),
  ]);
  return {
    bandMonths,
    countryMonths,
    total: totals?.total ?? 0,
    last30: totals?.last30 ?? 0,
    byMonth: fillMonths(byMonth),
    byBand,
    byCountry,
    imports,
    buyers: { known: buyers?.known ?? 0, onList: buyers?.onList ?? 0, unchecked: buyers?.unchecked ?? 0 },
    top,
  };
}

/** Every month from the first sign-up to now, so quiet months show as zero. */
function fillMonths(rows: { month: string; n: number }[]) {
  const valid = rows.filter((r) => /^\d{4}-\d{2}$/.test(r.month));
  if (!valid.length) return [];
  const n = new Map(valid.map((r) => [r.month, r.n]));
  const out: { month: string; n: number }[] = [];
  let [y, m] = valid[0].month.split("-").map(Number);
  const end = new Date().toISOString().slice(0, 7);
  for (let k = `${y}-${String(m).padStart(2, "0")}`; k <= end && out.length < 600; ) {
    out.push({ month: k, n: n.get(k) ?? 0 });
    m++;
    if (m > 12) [y, m] = [y + 1, 1];
    k = `${y}-${String(m).padStart(2, "0")}`;
  }
  return out;
}
