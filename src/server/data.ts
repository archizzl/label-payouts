import "server-only";
import { and, asc, eq, isNull, lte, type SQL } from "drizzle-orm";
import { db, schema } from "@/db";
import type { ReleasePackage } from "@/db/schema";
import type { ItemCategory } from "@/lib/bandcamp-csv";
import { type Catalog, normalizeId, normalizeText, routeSale } from "@/lib/routing";
import { computeLedger, type EngineContext, type EngineSale, type SaleResult, summarize } from "@/lib/splits";
import { expenseDeductions, projectReleaseMap } from "./expenses";

/*
 * Reads for one account. Every function takes the account's orgId and only ever sees its rows.
 */

const { bands, people, bandMemberships, releases, tracks, splitRules, splitShares, deductions, routingOverrides, sales } =
  schema;

export async function loadCatalog(orgId: string): Promise<Catalog> {
  const [releaseRows, bandRows, trackRows, overrides] = await Promise.all([
    db.select().from(releases).where(eq(releases.orgId, orgId)),
    db.select().from(bands).where(eq(bands.orgId, orgId)),
    db.select().from(tracks).where(eq(tracks.orgId, orgId)),
    db.select().from(routingOverrides).where(eq(routingOverrides.orgId, orgId)),
  ]);
  const releaseBand = new Map(releaseRows.map((r) => [r.id, r.bandId]));
  return {
    bands: bandRows.map((b) => ({ id: b.id, name: b.name, aliases: b.aliases, urlPatterns: b.urlPatterns })),
    releases: releaseRows.map((r) => ({
      id: r.id,
      bandId: r.bandId,
      title: r.title,
      url: r.url,
      identifiers: [
        r.catalogNumber,
        r.upc,
        ...r.packages.flatMap((p) => [p.sku, p.upc, ...(p.options ?? []).map((o) => o.sku)]),
      ].filter((x): x is string => !!x),
    })),
    tracks: trackRows.map((t) => ({
      id: t.id,
      releaseId: t.releaseId,
      bandId: t.bandId ?? releaseBand.get(t.releaseId)!,
      title: t.title,
      url: t.url,
      isrc: t.isrc,
    })),
    overrides,
  };
}

/** Re-run routing for every imported sale. Call after anything that changes the catalog or overrides. */
export async function reRouteAll(orgId: string) {
  const catalog = await loadCatalog(orgId);
  const rows = await db.select().from(sales).where(eq(sales.orgId, orgId));
  const changed = rows.flatMap((s) => {
    const r = routeSale({ ...s, catalogNumber: s.raw["catalog number"], upc: s.raw["upc"], isrc: s.raw["isrc"] }, catalog);
    return r.bandId !== s.bandId || r.releaseId !== s.releaseId || r.trackId !== s.trackId || r.via !== s.routedVia ? [{ id: s.id, r }] : [];
  });
  if (!changed.length) return;
  await db.transaction(async (tx) => {
    for (const { id, r } of changed) {
      await tx
        .update(sales)
        .set({ bandId: r.bandId, releaseId: r.releaseId, trackId: r.trackId, routedVia: r.via })
        .where(and(eq(sales.orgId, orgId), eq(sales.id, id)));
    }
  });
}

export async function loadEngineContext(orgId: string): Promise<EngineContext> {
  const [shareRows, memberRows, trackRows, outsideRows, labelBands, ruleRows, deductionRows, releaseRows, expenseRows, projectReleases] =
    await Promise.all([
    db.select().from(splitShares).where(eq(splitShares.orgId, orgId)),
    db
      .select()
      .from(bandMemberships)
      .where(and(eq(bandMemberships.orgId, orgId), eq(bandMemberships.active, true))),
    db.select().from(tracks).where(eq(tracks.orgId, orgId)).orderBy(asc(tracks.position), asc(tracks.id)),
    db.select().from(schema.outsideArtists).where(eq(schema.outsideArtists.orgId, orgId)),
    db
      .select({ id: bands.id })
      .from(bands)
      .where(and(eq(bands.orgId, orgId), eq(bands.isLabel, true))),
    db.select().from(splitRules).where(eq(splitRules.orgId, orgId)),
    db.select().from(deductions).where(eq(deductions.orgId, orgId)),
    db.select({ id: releases.id, albumSplitMode: releases.albumSplitMode }).from(releases).where(eq(releases.orgId, orgId)),
    db.select().from(schema.expenses).where(eq(schema.expenses.orgId, orgId)),
    projectReleaseMap(orgId),
  ]);
  const members = new Map<number, number[]>();
  for (const m of memberRows) members.set(m.bandId, [...(members.get(m.bandId) ?? []), m.personId]);
  const outside = new Map(outsideRows.map((a) => [a.id, a]));
  return {
    members,
    labelBandIds: new Set(labelBands.map((b) => b.id)),
    tracks: new Map(
      trackRows.map((t) => [
        t.id,
        {
          bandId: t.bandId,
          outside: t.outsideArtistId !== null,
          contactPersonId: t.outsideArtistId !== null ? (outside.get(t.outsideArtistId)?.contactPersonId ?? null) : null,
          labelKeeps: t.outsideArtistId !== null && !!outside.get(t.outsideArtistId)?.dismissed,
        },
      ]),
    ),
    rules: ruleRows.map((r) => ({
      ...r,
      itemCategory: r.itemCategory as ItemCategory | null,
      shares: shareRows.filter((s) => s.ruleId === r.id).map((s) => ({ personId: s.personId, bps: s.bps })),
    })),
    // Approved receipts being paid back from sales are recoupable costs like any other.
    deductions: [...deductionRows, ...expenseDeductions(expenseRows, projectReleases)],
    releases: releaseRows.map((r) => ({
      id: r.id,
      albumSplitMode: r.albumSplitMode,
      trackIds: trackRows.filter((t) => t.releaseId === r.id).map((t) => t.id),
    })),
  };
}

export type SaleRow = typeof sales.$inferSelect;

/** FNV-1a: a small, stable number for a string. */
function hash32(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * Compute the ledger for sales between start and end (inclusive). Runs over all history up to
 * `end` so recoupable costs carry over correctly, then keeps only sales in the window.
 */
export async function computePeriod(orgId: string, start: string, end: string) {
  const [rows, releaseRows, ctx] = await Promise.all([
    db
      .select()
      .from(sales)
      .where(and(eq(sales.orgId, orgId), lte(sales.date, end))),
    db.select({ id: releases.id, packages: releases.packages }).from(releases).where(eq(releases.orgId, orgId)),
    loadEngineContext(orgId),
  ]);
  const packagesByRelease = new Map(releaseRows.map((r) => [r.id, r.packages]));
  const engineSales: EngineSale[] = rows.map((s) => {
    const { pkg, format } = salePackage(s, s.releaseId ? (packagesByRelease.get(s.releaseId) ?? []) : []);
    return {
      id: s.id,
      date: s.date,
      bandId: s.bandId,
      releaseId: s.releaseId,
      trackId: s.trackId,
      category: s.category,
      currency: s.currency,
      netCents: s.netCents,
      quantity: s.quantity,
      format,
      packageId: pkg?.bandcampId ?? null,
      tieKey: hash32(s.dedupeKey),
    };
  });
  const all = computeLedger(engineSales, ctx);
  const saleById = new Map(rows.map((s) => [s.id, s]));
  const results: SaleResult[] = all.filter((r) => saleById.get(r.saleId)!.date >= start);
  return { results, saleById, summary: summarize(results) };
}

/**
 * Which of the release's formats a merch sale was: by SKU or UPC first (including size/option
 * SKUs), then by package name. Returns the format and words describing it ("CD Compact Disc (CD)"),
 * used by per-item costs. Digital sales have no format.
 */
export function salePackage(s: SaleRow, packages: ReleasePackage[]): { pkg: ReleasePackage | null; format: string } {
  if (s.category !== "merch") return { pkg: null, format: "" };
  const ids = [s.raw["sku"], s.raw["catalog number"], s.raw["upc"]].map(normalizeId).filter((x) => x.length >= 3);
  const bySku = ids.length
    ? packages.find((p) => [p.sku, p.upc, ...(p.options ?? []).map((o) => o.sku)].some((x) => x && ids.includes(normalizeId(x))))
    : undefined;
  const name = s.packageName || s.itemName;
  const n = normalizeText(name);
  const pkg =
    bySku ??
    packages.find((p) => normalizeText(p.title) === n) ??
    packages.find((p) => p.title && ` ${n} `.includes(` ${normalizeText(p.title)} `)) ??
    null;
  return { pkg, format: [name, pkg?.title, pkg?.typeName].filter(Boolean).join(" ") };
}

type PeriodScope = { id: number; startDate: string; endDate: string; bandId: number | null };

/**
 * The sales a payout period pays: in its dates, for its band (or the whole label), and not
 * already paid by another finalized period. A sale is already paid if a finalized period for the
 * whole label, or for that sale's band, covers its date. That's what lets you pay bands one at a
 * time without anything being paid twice.
 */
export async function computePayoutPeriod(orgId: string, period: PeriodScope) {
  const [{ results, saleById }, periodRows] = await Promise.all([
    computePeriod(orgId, period.startDate, period.endDate),
    db.select().from(schema.periods).where(eq(schema.periods.orgId, orgId)),
  ]);
  const others = periodRows.filter((o) => o.id !== period.id);
  const alreadyPaid = new Map<number, number>(); // other period id → sales it already covered
  const mine = results.filter((r) => {
    const s = saleById.get(r.saleId)!;
    if (period.bandId !== null && s.bandId !== period.bandId) return false;
    const by = others.find((o) => s.date >= o.startDate && s.date <= o.endDate && (o.bandId === null || o.bandId === s.bandId));
    if (by) {
      alreadyPaid.set(by.id, (alreadyPaid.get(by.id) ?? 0) + 1);
      return false;
    }
    return true;
  });
  return {
    results: mine,
    saleById,
    summary: summarize(mine),
    alreadyPaid: [...alreadyPaid].map(([periodId, sales]) => ({ period: others.find((o) => o.id === periodId)!, sales })),
  };
}

export function computeAllTime(orgId: string) {
  return computePeriod(orgId, "0000-01-01", "9999-12-31");
}

export type NameMaps = Awaited<ReturnType<typeof nameMaps>>;

export async function nameMaps(orgId: string) {
  const [bandRows, peopleRows, releaseRows, trackRows] = await Promise.all([
    db.select({ id: bands.id, name: bands.name }).from(bands).where(eq(bands.orgId, orgId)),
    db.select({ id: people.id, name: people.name }).from(people).where(eq(people.orgId, orgId)),
    db.select({ id: releases.id, title: releases.title, packages: releases.packages }).from(releases).where(eq(releases.orgId, orgId)),
    db.select({ id: tracks.id, title: tracks.title }).from(tracks).where(eq(tracks.orgId, orgId)),
  ]);
  return {
    band: new Map(bandRows.map((b) => [b.id, b.name])),
    person: new Map(peopleRows.map((p) => [p.id, p.name])),
    release: new Map(releaseRows.map((r) => [r.id, r.title])),
    track: new Map(trackRows.map((t) => [t.id, t.title])),
    /** Bandcamp package id → "Release — Format" */
    format: new Map(releaseRows.flatMap((r) => r.packages.map((p) => [p.bandcampId, `${r.title} — ${p.title}`] as [number, string]))),
  };
}

export async function bandMembers(orgId: string, bandId: number) {
  return db
    .select({
      membershipId: bandMemberships.id,
      roles: bandMemberships.roles,
      active: bandMemberships.active,
      person: people,
    })
    .from(bandMemberships)
    .innerJoin(people, eq(people.id, bandMemberships.personId))
    .where(and(eq(bandMemberships.orgId, orgId), eq(bandMemberships.bandId, bandId)))
    .orderBy(asc(people.name));
}

export type RuleWithShares = typeof splitRules.$inferSelect & { shares: { personId: number; bps: number }[] };

export async function rulesWhere(orgId: string, where: SQL): Promise<RuleWithShares[]> {
  const [rows, shareRows] = await Promise.all([
    db
      .select()
      .from(splitRules)
      .where(and(eq(splitRules.orgId, orgId), where))
      .orderBy(asc(splitRules.effectiveFrom)),
    db.select().from(splitShares).where(eq(splitShares.orgId, orgId)),
  ]);
  return rows.map((r) => ({
    ...r,
    shares: shareRows.filter((s) => s.ruleId === r.id).map((s) => ({ personId: s.personId, bps: s.bps })),
  }));
}

export function ruleFilter(
  scope: "label_default" | "band_default" | "band_item_type" | "release" | "track",
  ref: { bandId?: number; releaseId?: number; trackId?: number; itemCategory?: ItemCategory },
) {
  const conds = [eq(splitRules.scope, scope)];
  if (ref.bandId !== undefined) conds.push(eq(splitRules.bandId, ref.bandId));
  if (ref.releaseId !== undefined) conds.push(eq(splitRules.releaseId, ref.releaseId));
  if (ref.trackId !== undefined) conds.push(eq(splitRules.trackId, ref.trackId));
  if (ref.itemCategory !== undefined) conds.push(eq(splitRules.itemCategory, ref.itemCategory));
  return and(...conds)!;
}

/** Sales grouped by routing key, for the "needs routing" queue. */
export async function unroutedGroups(orgId: string, mode: "no_band" | "no_release") {
  const rows = (
    await db
      .select()
      .from(sales)
      .where(
        and(eq(sales.orgId, orgId), mode === "no_band" ? isNull(sales.bandId) : and(isNull(sales.releaseId), isNull(sales.trackId))),
      )
      .orderBy(asc(sales.date))
  ).filter((s) => mode === "no_band" || (s.bandId !== null && (s.category === "album" || s.category === "track")));
  const groups = new Map<
    string,
    { key: string; artist: string; itemName: string; itemUrl: string; category: string; bandId: number | null; count: number; totals: Map<string, number> }
  >();
  for (const s of rows) {
    const g = groups.get(s.routingKey) ?? {
      key: s.routingKey,
      artist: s.artist,
      itemName: s.itemName,
      itemUrl: s.itemUrl,
      category: s.category,
      bandId: s.bandId,
      count: 0,
      totals: new Map<string, number>(),
    };
    g.count++;
    g.totals.set(s.currency, (g.totals.get(s.currency) ?? 0) + s.netCents);
    groups.set(s.routingKey, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/** People for a split editor: the band's current members first (flagged inBand), then everyone else. */
export async function personOptionsFor(orgId: string, bandId: number) {
  const [members, everyone] = await Promise.all([
    bandMembers(orgId, bandId),
    db.select().from(people).where(eq(people.orgId, orgId)).orderBy(asc(people.name)),
  ]);
  const current = members.filter((m) => m.active);
  return [
    ...current.map((m) => ({ id: m.person.id, name: m.person.name, roles: m.roles, inBand: true })),
    ...everyone.filter((p) => !current.some((m) => m.person.id === p.id)).map((p) => ({ id: p.id, name: p.name, inBand: false })),
  ];
}

/**
 * People associated with a band, for choosing who gets paid: its members (current first), then
 * anyone with a share in one of its splits (e.g. a producer on one release).
 */
export async function bandAssociatedPeople(orgId: string, bandId: number): Promise<{ id: number; name: string }[]> {
  const [members, releaseRows, trackRows, ruleRows, shareRows, peopleRows] = await Promise.all([
    bandMembers(orgId, bandId),
    db
      .select({ id: releases.id })
      .from(releases)
      .where(and(eq(releases.orgId, orgId), eq(releases.bandId, bandId))),
    db.select().from(tracks).where(eq(tracks.orgId, orgId)),
    db.select().from(splitRules).where(eq(splitRules.orgId, orgId)),
    db.select().from(splitShares).where(eq(splitShares.orgId, orgId)),
    db.select().from(people).where(eq(people.orgId, orgId)).orderBy(asc(people.name)),
  ]);
  const releaseIds = new Set(releaseRows.map((r) => r.id));
  const trackIds = new Set(trackRows.filter((t) => releaseIds.has(t.releaseId) || t.bandId === bandId).map((t) => t.id));
  const ruleIds = new Set(
    ruleRows
      .filter((r) => r.bandId === bandId || (r.releaseId !== null && releaseIds.has(r.releaseId)) || (r.trackId !== null && trackIds.has(r.trackId)))
      .map((r) => r.id),
  );
  const sharers = new Set(shareRows.filter((s) => ruleIds.has(s.ruleId)).map((s) => s.personId));
  const memberIds = new Set(members.map((m) => m.person.id));
  return [
    ...members.filter((m) => m.active).map((m) => m.person),
    ...members.filter((m) => !m.active).map((m) => m.person),
    ...peopleRows.filter((p) => sharers.has(p.id) && !memberIds.has(p.id)),
  ].map((p) => ({ id: p.id, name: p.name }));
}

/** Per-item costs that could apply on a band's formats and merch: its own and label-wide ones. */
export async function costDeductionsFor(orgId: string, bandId: number) {
  return (await db.select().from(deductions).where(eq(deductions.orgId, orgId))).filter((d) => d.bandId === bandId || d.bandId === null);
}

/**
 * The Bandcamp account a label's own band lives on, e.g. "reactionfuturerecords.bandcamp.com".
 * It has no address pattern of its own (that would claim every release hosted on the label's
 * account), so it's read from where its releases are.
 */
export async function labelHost(orgId: string, bandId: number): Promise<string | null> {
  const hosts = new Map<string, number>();
  const rows = await db
    .select({ url: releases.url })
    .from(releases)
    .where(and(eq(releases.orgId, orgId), eq(releases.bandId, bandId)));
  for (const r of rows) {
    try {
      const host = new URL(r.url ?? "").host;
      hosts.set(host, (hosts.get(host) ?? 0) + 1);
    } catch {}
  }
  return [...hosts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

type Totals = Map<string, number>; // currency → cents
const addTo = (m: Totals, currency: string, cents: number) => m.set(currency, (m.get(currency) ?? 0) + cents);

/** What a transfer out was for: its release if it names one, otherwise its band. */
export type FundCause = { bandId: number | null; releaseId: number | null };
const causeKey = (c: FundCause) => (c.releaseId ? `r${c.releaseId}` : c.bandId ? `b${c.bandId}` : "");

/**
 * The label's own money: everything it kept from sales (its cut, its share of label releases,
 * fundraisers routed to it), what it has sent on to others, and what's left. Also, for each band
 * and release that transfers were made for, how much it raised for the label and how much went out.
 */
export async function labelFunds(orgId: string) {
  const [{ results, saleById }, transferRows, expenseRows] = await Promise.all([
    computeAllTime(orgId),
    db.select().from(schema.labelTransfers).where(eq(schema.labelTransfers.orgId, orgId)),
    db.select().from(schema.expenses).where(and(eq(schema.expenses.orgId, orgId), eq(schema.expenses.status, "approved"))),
  ]);
  const kept: Totals = new Map();
  const raised = new Map<string, Totals>(); // cause key → kept from its sales
  for (const r of results) {
    const cents = r.deductions.filter((d) => d.destination === "label").reduce((a, d) => a + d.cents, 0);
    if (!cents) continue;
    addTo(kept, r.currency, cents);
    const sale = saleById.get(r.saleId);
    for (const key of [r.bandId && `b${r.bandId}`, sale?.releaseId && `r${sale.releaseId}`]) {
      if (!key) continue;
      const m = raised.get(key) ?? new Map();
      addTo(m, r.currency, cents);
      raised.set(key, m);
    }
  }

  const transfers = transferRows.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  const sent: Totals = new Map();
  const causes = new Map<string, FundCause & { raised: Totals; sent: Totals }>();
  for (const t of transfers) {
    addTo(sent, t.currency, t.amountCents);
    const key = causeKey(t);
    if (!key) continue;
    const c = causes.get(key) ?? { bandId: t.bandId, releaseId: t.releaseId, raised: raised.get(key) ?? new Map(), sent: new Map() };
    addTo(c.sent, t.currency, t.amountCents);
    causes.set(key, c);
  }
  // Expenses the label paid for (whether or not sales pay it back: that comes in as money kept), and
  // people it has reimbursed for things they paid for.
  const spent: Totals = new Map();
  for (const e of expenseRows) {
    if (e.paidBy === "label" || (e.paidBy === "person" && !e.recoup && e.reimbursedAt)) addTo(spent, e.currency, e.amountCents);
  }
  const balance: Totals = new Map();
  for (const cur of new Set([...kept.keys(), ...sent.keys(), ...spent.keys()])) {
    balance.set(cur, (kept.get(cur) ?? 0) - (sent.get(cur) ?? 0) - (spent.get(cur) ?? 0));
  }

  return {
    kept,
    sent,
    spent,
    balance,
    transfers,
    causes: [...causes.values()],
    raisedBy: (c: FundCause) => raised.get(causeKey(c)) ?? new Map(),
  };
}
