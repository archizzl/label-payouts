"use server";

import { and, eq, gt, inArray, ne } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import { type ItemCategory, type ParseResult, parseBandcampApiReport, parseBandcampCsv } from "@/lib/bandcamp-csv";
import {
  type LabelArtist,
  type LabelRelease,
  labelArtistsUrl,
  labelMerchUrl,
  labelMusicUrl,
  parseLabelArtists,
  parseLabelMerch,
  parseLabelMusic,
  parseLabelName,
} from "@/lib/bandcamp-label";
import { parseReleasePage } from "@/lib/bandcamp-release";
import { parseCents } from "@/lib/money";
import { cleanCashtag, cleanVenmoHandle } from "@/lib/paypal-export";
import { normalizeText, routeSale, routingKey } from "@/lib/routing";
import { allBands, createBandFor, fetchPage, findBandFor, findExistingRelease, hostOf, rememberLabelPhoto, upsertRelease } from "./bandcamp";
import { API_SYNC_PREFIX, bandcampCredentials, salesReport } from "./bandcamp-api";
import { requireAdmin } from "./context";
import { computePayoutPeriod, loadCatalog, reRouteAll } from "./data";
import { type PayoutScope, payoutName } from "./period-view";
import { autoMergeByEmail, findExistingPerson, mergePeople } from "./people";

/*
 * Every action here changes an account's books, so every one starts with requireAdmin(): the caller
 * must be signed in and an owner or admin of the account they're working in. Every query is scoped
 * to that account (orgId), and ids that arrive from forms are checked to belong to it.
 */

const {
  bands,
  people,
  bandMemberships,
  releases,
  tracks,
  splitRules,
  splitShares,
  deductions,
  routingOverrides,
  imports,
  sales,
  periods,
  payouts,
  labelTransfers,
  outsideArtists,
} = schema;

// ---------- form helpers ----------

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const optStr = (fd: FormData, k: string) => str(fd, k) || null;
const int = (fd: FormData, k: string) => {
  const n = Number.parseInt(str(fd, k), 10);
  if (!Number.isFinite(n)) throw new Error(`Missing ${k}`);
  return n;
};
const optInt = (fd: FormData, k: string) => {
  const n = Number.parseInt(str(fd, k), 10);
  return Number.isFinite(n) ? n : null;
};
const list = (fd: FormData, k: string) =>
  str(fd, k)
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
const bool = (fd: FormData, k: string) => fd.get(k) === "on" || fd.get(k) === "true";
const isoDate = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
const category = (s: string | null) =>
  (["album", "track", "merch", "other"].includes(s ?? "") ? s : null) as ItemCategory | null;

/** Venmo username and Cash App cashtag from a form, tidied ("@name", "$name" or a link all work). */
function payHandles(fd: FormData) {
  return {
    venmo: cleanVenmoHandle(str(fd, "venmo")) || null,
    cashtag: cleanCashtag(str(fd, "cashtag")) || null,
  };
}

type OwnedTable = PgTable & { id: AnyPgColumn; orgId: AnyPgColumn };

/**
 * Make sure every id (from a form) is a row of this account. Anything else is refused, so nobody
 * can point their data at another account's bands, people or releases.
 */
async function owned(orgId: string, table: OwnedTable, ...ids: (number | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((x): x is number => typeof x === "number"))];
  if (!wanted.length) return;
  const found = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.orgId, orgId), inArray(table.id, wanted)));
  if (found.length !== wanted.length) throw new Error("That item isn't part of this account.");
}

function done() {
  revalidatePath("/", "layout");
}

export type ActionState = { ok?: string; error?: string } | null;

// ---------- bands ----------

export async function saveBand(fd: FormData) {
  const { orgId } = await requireAdmin();
  const id = optInt(fd, "id");
  const values = {
    name: str(fd, "name"),
    aliases: list(fd, "aliases"),
    urlPatterns: list(fd, "urlPatterns"),
    notes: optStr(fd, "notes"),
  };
  if (!values.name) throw new Error("Band name is required");
  let bandId = id;
  if (id) await db.update(bands).set(values).where(and(eq(bands.orgId, orgId), eq(bands.id, id)));
  else [{ id: bandId }] = await db.insert(bands).values({ ...values, orgId }).returning({ id: bands.id });
  await reRouteAll(orgId);
  done();
  if (!id) redirect(`/bands/${bandId}`);
}

export async function deleteBand(fd: FormData) {
  const { orgId } = await requireAdmin();
  const id = int(fd, "id");
  const [hasPayouts] = await db
    .select({ id: periods.id })
    .from(periods)
    .where(and(eq(periods.orgId, orgId), eq(periods.bandId, id)));
  if (hasPayouts) throw new Error("This band has its own payout history, so it can't be deleted. Delete those payout periods first.");
  await db.delete(bands).where(and(eq(bands.orgId, orgId), eq(bands.id, id)));
  await reRouteAll(orgId);
  done();
  redirect("/bands");
}

// ---------- people & memberships ----------

export async function savePerson(fd: FormData) {
  const { orgId } = await requireAdmin();
  const id = optInt(fd, "id");
  const values = {
    name: str(fd, "name"),
    email: optStr(fd, "email"),
    paypalMe: optStr(fd, "paypalMe"),
    ...payHandles(fd),
    notes: optStr(fd, "notes"),
  };
  if (!values.name) throw new Error("Name is required");
  if (id) await db.update(people).set(values).where(and(eq(people.orgId, orgId), eq(people.id, id)));
  else {
    // Adding someone who's already here (same email, or same name without a conflicting email)
    // fills in their details instead of creating a duplicate.
    const existing = await findExistingPerson(orgId, values.name, values.email);
    if (existing) {
      await db
        .update(people)
        .set({
          email: existing.email || values.email,
          paypalMe: existing.paypalMe || values.paypalMe,
          venmo: existing.venmo || values.venmo,
          cashtag: existing.cashtag || values.cashtag,
          notes: existing.notes || values.notes,
        })
        .where(eq(people.id, existing.id));
    } else await db.insert(people).values({ ...values, orgId });
  }
  if ((await autoMergeByEmail(orgId)).length) await syncAllPeriodStatuses(orgId);
  done();
}

/** Merge one person into another (from the People page). */
export async function mergePeopleAction(fd: FormData) {
  const { orgId } = await requireAdmin();
  const intoId = int(fd, "intoId");
  for (const from of fd.getAll("fromId")) await mergePeople(orgId, intoId, Number(from));
  await syncAllPeriodStatuses(orgId);
  done();
}

export async function deletePerson(_: ActionState, fd: FormData): Promise<ActionState> {
  const { orgId } = await requireAdmin();
  const id = int(fd, "id");
  await owned(orgId, people, id);
  const [hasPayouts] = await db.select({ id: payouts.id }).from(payouts).where(eq(payouts.personId, id));
  if (hasPayouts) return { error: "This person has payout history, so they can't be deleted. Remove them from their bands instead." };
  const paidTo = await db.select().from(deductions).where(eq(deductions.personId, id));
  if (paidTo.length) {
    return { error: `This person is paid by the deduction “${paidTo[0].label}”. Change or delete it first (under label rules or the band page).` };
  }
  await db.delete(people).where(and(eq(people.orgId, orgId), eq(people.id, id)));
  done();
  return { ok: "Deleted" };
}

/** Add an existing person (personId) or a new one (name/email) to a band. */
export async function addMember(fd: FormData) {
  const { orgId } = await requireAdmin();
  const bandId = int(fd, "bandId");
  let personId = optInt(fd, "personId");
  await owned(orgId, bands, bandId);
  await owned(orgId, people, personId);
  if (!personId) {
    const name = str(fd, "name");
    if (!name) throw new Error("Pick a person or enter a name");
    // Already in another band? Reuse them, so they get one combined payment.
    const existing = await findExistingPerson(orgId, name, optStr(fd, "email"));
    if (existing) {
      personId = existing.id;
      const h = payHandles(fd);
      await db
        .update(people)
        .set({
          email: existing.email || optStr(fd, "email"),
          paypalMe: existing.paypalMe || optStr(fd, "paypalMe"),
          venmo: existing.venmo || h.venmo,
          cashtag: existing.cashtag || h.cashtag,
        })
        .where(eq(people.id, existing.id));
    } else {
      [{ id: personId }] = await db
        .insert(people)
        .values({ orgId, name, email: optStr(fd, "email"), paypalMe: optStr(fd, "paypalMe"), ...payHandles(fd) })
        .returning({ id: people.id });
    }
  }
  await db
    .insert(bandMemberships)
    .values({ orgId, bandId, personId, roles: list(fd, "roles") })
    .onConflictDoUpdate({ target: [bandMemberships.bandId, bandMemberships.personId], set: { active: true } });
  done();
}

/** Edit a band member: their roles and status in this band, and their name and PayPal details. */
export async function updateMembership(fd: FormData) {
  const { orgId } = await requireAdmin();
  const [m] = await db
    .update(bandMemberships)
    .set({ roles: list(fd, "roles"), active: bool(fd, "active") })
    .where(and(eq(bandMemberships.orgId, orgId), eq(bandMemberships.id, int(fd, "membershipId"))))
    .returning();
  if (m && fd.has("name")) {
    const name = str(fd, "name");
    await db
      .update(people)
      .set({ ...(name ? { name } : {}), email: optStr(fd, "email"), paypalMe: optStr(fd, "paypalMe"), ...payHandles(fd) })
      .where(and(eq(people.orgId, orgId), eq(people.id, m.personId)));
    await autoMergeByEmail(orgId);
  }
  done();
}

export async function removeMember(fd: FormData) {
  const { orgId } = await requireAdmin();
  await db.delete(bandMemberships).where(and(eq(bandMemberships.orgId, orgId), eq(bandMemberships.id, int(fd, "membershipId"))));
  done();
}

// ---------- catalog ----------

export async function saveRelease(fd: FormData) {
  const { orgId } = await requireAdmin();
  const id = optInt(fd, "id");
  const values = {
    bandId: int(fd, "bandId"),
    title: str(fd, "title"),
    url: optStr(fd, "url"),
    catalogNumber: optStr(fd, "catalogNumber"),
    releaseDate: isoDate(optStr(fd, "releaseDate")),
    albumSplitMode: (str(fd, "albumSplitMode") === "average_tracks" ? "average_tracks" : "band_default") as
      | "average_tracks"
      | "band_default",
  };
  if (!values.title) throw new Error("Title is required");
  await owned(orgId, bands, values.bandId);
  let releaseId = id;
  if (id) await db.update(releases).set(values).where(and(eq(releases.orgId, orgId), eq(releases.id, id)));
  else [{ id: releaseId }] = await db.insert(releases).values({ ...values, orgId }).returning({ id: releases.id });
  await reRouteAll(orgId);
  done();
  if (!id && bool(fd, "open")) redirect(`/catalog/${releaseId}`);
}

export async function deleteRelease(fd: FormData) {
  const { orgId } = await requireAdmin();
  const [r] = await db
    .delete(releases)
    .where(and(eq(releases.orgId, orgId), eq(releases.id, int(fd, "id"))))
    .returning();
  await reRouteAll(orgId);
  done();
  redirect(r ? `/bands/${r.bandId}` : "/catalog");
}

/** Add tracks: one title per line, optionally "Title | URL". */
export async function addTracks(fd: FormData) {
  const { orgId } = await requireAdmin();
  const releaseId = int(fd, "releaseId");
  await owned(orgId, releases, releaseId);
  const existing = (await db.select({ id: tracks.id }).from(tracks).where(eq(tracks.releaseId, releaseId))).length;
  const lines = str(fd, "titles")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length) {
    await db.insert(tracks).values(
      lines.map((line, i) => {
        const [title, url] = line.split("|").map((s) => s.trim());
        return { orgId, releaseId, title, url: url || null, position: existing + i + 1 };
      }),
    );
  }
  await reRouteAll(orgId);
  done();
}

export async function saveTrack(fd: FormData) {
  const { orgId } = await requireAdmin();
  const bandId = optInt(fd, "bandId");
  await owned(orgId, bands, bandId);
  await db
    .update(tracks)
    .set({
      title: str(fd, "title"),
      url: optStr(fd, "url"),
      isrc: optStr(fd, "isrc"),
      bandId,
      position: optInt(fd, "position") ?? 0,
    })
    .where(and(eq(tracks.orgId, orgId), eq(tracks.id, int(fd, "id"))));
  await reRouteAll(orgId);
  done();
}

export async function deleteTrack(fd: FormData) {
  const { orgId } = await requireAdmin();
  await db.delete(tracks).where(and(eq(tracks.orgId, orgId), eq(tracks.id, int(fd, "id"))));
  await reRouteAll(orgId);
  done();
}

// ---------- split rules ----------

export async function saveSplitRule(_: ActionState, fd: FormData): Promise<ActionState> {
  const { orgId } = await requireAdmin();
  const scope = str(fd, "scope") as "label_default" | "band_default" | "band_item_type" | "release" | "track";
  if (!["label_default", "band_default", "band_item_type", "release", "track"].includes(scope)) return { error: "Bad scope" };
  const shares = (JSON.parse(str(fd, "shares") || "[]") as { personId: number; bps: number }[]).filter((s) => s.bps > 0);
  const total = shares.reduce((a, s) => a + s.bps, 0);
  if (scope === "label_default") {
    // Carve-outs are optional; whatever is left goes evenly to each band's members.
    if (total > 10000) return { error: `Carve-outs add up to ${(total / 100).toFixed(2)}%, more than 100%` };
  } else {
    if (shares.length === 0) return { error: "Give at least one person a share" };
    if (total !== 10000) return { error: `Shares add up to ${(total / 100).toFixed(2)}%, not 100%` };
  }
  const effectiveFrom = isoDate(optStr(fd, "effectiveFrom")) ?? "2000-01-01";
  const values = {
    scope,
    bandId: optInt(fd, "bandId"),
    releaseId: optInt(fd, "releaseId"),
    trackId: optInt(fd, "trackId"),
    itemCategory: category(optStr(fd, "itemCategory")),
    overridesCatalog: bool(fd, "overridesCatalog"),
    effectiveFrom,
    note: optStr(fd, "note"),
  };
  await owned(orgId, bands, values.bandId);
  await owned(orgId, releases, values.releaseId);
  await owned(orgId, tracks, values.trackId);
  await owned(orgId, people, ...shares.map((s) => s.personId));
  const ruleId = optInt(fd, "ruleId");
  await owned(orgId, splitRules, ruleId);
  await db.transaction(async (tx) => {
    let id = ruleId;
    if (id) {
      await tx.update(splitRules).set(values).where(eq(splitRules.id, id));
      await tx.delete(splitShares).where(eq(splitShares.ruleId, id));
    } else {
      [{ id }] = await tx
        .insert(splitRules)
        .values({ ...values, orgId })
        .returning({ id: splitRules.id });
    }
    if (shares.length) await tx.insert(splitShares).values(shares.map((s) => ({ orgId, ruleId: id!, personId: s.personId, bps: s.bps })));
  });
  done();
  return { ok: "Split saved" };
}

export async function deleteSplitRule(fd: FormData) {
  const { orgId } = await requireAdmin();
  await db.delete(splitRules).where(and(eq(splitRules.orgId, orgId), eq(splitRules.id, int(fd, "ruleId"))));
  done();
}

// ---------- deductions ----------

export async function saveDeduction(fd: FormData) {
  const { orgId } = await requireAdmin();
  const kindRaw = str(fd, "kind");
  const kind = (["percent", "fixed", "per_unit"].includes(kindRaw) ? kindRaw : "percent") as "percent" | "fixed" | "per_unit";
  const dest = str(fd, "destination");
  const destination = (["label", "band_fund", "expense", "person"].includes(dest) ? dest : "label") as
    | "label"
    | "band_fund"
    | "expense"
    | "person";
  const personId = destination === "person" ? optInt(fd, "personId") : null;
  // "releaseId:packageId": one specific format of a release (e.g. its CD, not its vinyl).
  const [formatRelease, formatPackage] = str(fd, "formatKey").split(":").map(Number);
  const packageId = Number.isFinite(formatPackage) && formatPackage > 0 ? formatPackage : null;
  if (destination === "person" && !personId) throw new Error("Choose who gets paid");
  const values = {
    label: str(fd, "label") || (kind === "percent" ? "Deduction" : kind === "per_unit" ? "Per-item cost" : "Recoupable cost"),
    kind,
    percentBps: kind === "percent" ? Math.round(Number.parseFloat(str(fd, "percent")) * 100) || 0 : null,
    amountCents: kind !== "percent" ? Math.round(Number.parseFloat(str(fd, "amount")) * 100) || 0 : null,
    currency: kind !== "percent" ? str(fd, "currency").toUpperCase() || "USD" : null,
    destination,
    personId,
    bandId: optInt(fd, "bandId"),
    releaseId: packageId ? formatRelease : optInt(fd, "releaseId"),
    trackId: optInt(fd, "trackId"),
    // A specific format is always merch, whatever the item-type field says.
    itemCategory: packageId ? ("merch" as const) : category(optStr(fd, "itemCategory")),
    formatMatch: packageId ? null : optStr(fd, "formatMatch"),
    packageId,
    effectiveFrom: isoDate(optStr(fd, "effectiveFrom")),
    effectiveTo: isoDate(optStr(fd, "effectiveTo")),
    sortOrder: optInt(fd, "sortOrder") ?? 0,
  };
  await owned(orgId, people, values.personId);
  await owned(orgId, bands, values.bandId);
  await owned(orgId, releases, values.releaseId);
  await owned(orgId, tracks, values.trackId);
  const id = optInt(fd, "id");
  if (id) await db.update(deductions).set(values).where(and(eq(deductions.orgId, orgId), eq(deductions.id, id)));
  else await db.insert(deductions).values({ ...values, orgId });
  done();
}

export async function deleteDeduction(fd: FormData) {
  const { orgId } = await requireAdmin();
  await db.delete(deductions).where(and(eq(deductions.orgId, orgId), eq(deductions.id, int(fd, "id"))));
  done();
}

// ---------- import ----------

export type ImportPreview = {
  filename: string;
  error?: string;
  missingColumns?: string[];
  headers?: string[];
  total: number;
  fresh: number;
  duplicates: number;
  skipped: { row: number; reason: string }[];
  dateRange: [string, string] | null;
  byBand: { band: string; count: number; totals: Record<string, number> }[];
  unrouted: number;
};

async function readUpload(fd: FormData) {
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) throw new Error("Choose a CSV file");
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

async function prepare(orgId: string, parsed: ParseResult) {
  const catalog = await loadCatalog(orgId);
  const keys = parsed.sales.map((s) => s.dedupeKey);
  const existing = new Set<string>();
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    const found = await db
      .select({ k: sales.dedupeKey })
      .from(sales)
      .where(and(eq(sales.orgId, orgId), inArray(sales.dedupeKey, chunk)));
    for (const r of found) existing.add(r.k);
  }
  const routed = parsed.sales.map((s) => ({ sale: s, route: routeSale(s, catalog), duplicate: existing.has(s.dedupeKey) }));
  return { parsed, routed, catalog };
}

export async function previewImport(_: ImportPreview | null, fd: FormData): Promise<ImportPreview> {
  const { orgId } = await requireAdmin();
  let name = "file";
  try {
    const up = await readUpload(fd);
    name = up.name;
    const { parsed, routed, catalog } = await prepare(orgId, parseBandcampCsv(up.bytes));
    const base = { filename: name, total: 0, fresh: 0, duplicates: 0, skipped: parsed.skipped, dateRange: null, byBand: [], unrouted: 0 };
    if (parsed.missingColumns.length) {
      return {
        ...base,
        error: "This doesn't look like a Bandcamp sales report.",
        missingColumns: parsed.missingColumns,
        headers: parsed.headers,
      };
    }
    const fresh = routed.filter((r) => !r.duplicate);
    const bandName = new Map(catalog.bands.map((b) => [b.id, b.name]));
    const byBand = new Map<string, { band: string; count: number; totals: Record<string, number> }>();
    for (const r of fresh) {
      const label = r.route.bandId ? bandName.get(r.route.bandId)! : "⚠ Unrouted";
      const g = byBand.get(label) ?? { band: label, count: 0, totals: {} };
      g.count++;
      g.totals[r.sale.currency] = (g.totals[r.sale.currency] ?? 0) + r.sale.netCents;
      byBand.set(label, g);
    }
    const dates = parsed.sales.map((s) => s.date).sort();
    return {
      ...base,
      total: parsed.sales.length,
      fresh: fresh.length,
      duplicates: routed.length - fresh.length,
      dateRange: dates.length ? [dates[0], dates[dates.length - 1]] : null,
      byBand: [...byBand.values()].sort((a, b) => a.band.localeCompare(b.band)),
      unrouted: fresh.filter((r) => r.route.bandId === null).length,
    };
  } catch (e) {
    return { filename: name, error: (e as Error).message, total: 0, fresh: 0, duplicates: 0, skipped: [], dateRange: null, byBand: [], unrouted: 0 };
  }
}

export async function commitImport(fd: FormData): Promise<{ importId?: number; error?: string }> {
  const { orgId } = await requireAdmin();
  const up = await readUpload(fd);
  const parsed = parseBandcampCsv(up.bytes);
  if (parsed.missingColumns.length) return { error: "Not a Bandcamp sales report" };
  const { importId } = await saveSales(orgId, up.name, parsed);
  done();
  return { importId };
}

/** Store the new (not yet imported) sales of a parsed report as one import. */
async function saveSales(orgId: string, filename: string, parsed: ParseResult) {
  const { routed } = await prepare(orgId, parsed);
  const fresh = routed.filter((r) => !r.duplicate);
  const importId = await db.transaction(async (tx) => {
    const [{ id }] = await tx
      .insert(imports)
      .values({ orgId, filename, rowCount: routed.length, addedCount: fresh.length, duplicateCount: routed.length - fresh.length })
      .returning({ id: imports.id });
    for (let i = 0; i < fresh.length; i += 500) {
      await tx
        .insert(sales)
        .values(
          fresh.slice(i, i + 500).map(({ sale: s, route }) => ({
            orgId,
            importId: id,
            dedupeKey: s.dedupeKey,
            date: s.date,
            itemType: s.itemType,
            category: s.category,
            itemName: s.itemName,
            artist: s.artist,
            itemUrl: s.itemUrl,
            packageName: s.packageName,
            currency: s.currency,
            netCents: s.netCents,
            quantity: s.quantity,
            transactionId: s.transactionId,
            routingKey: routingKey(s),
            bandId: route.bandId,
            releaseId: route.releaseId,
            trackId: route.trackId,
            routedVia: route.via,
            raw: s.raw,
          })),
        )
        .onConflictDoNothing();
    }
    return id;
  });
  return { importId, added: fresh.length, duplicates: routed.length - fresh.length };
}

/**
 * Pull the account's raw sales report straight from the Bandcamp API and import what's new. The
 * whole history is fetched each time (late refunds included); anything already imported, whether
 * by an earlier sync or a CSV upload, is skipped. Throws if Bandcamp can't be reached.
 */
async function runSalesSync(orgId: string, from = "2000-01-01") {
  const creds = await bandcampCredentials(orgId);
  if (!creds) throw new Error("This account has no Bandcamp API access set up. Add it under Settings.");
  const report = await salesReport(creds, new Date(`${from}T00:00:00Z`), new Date(Date.now() + 86_400_000));
  const parsed = parseBandcampApiReport(report.rows);
  if (parsed.missingColumns.length) throw new Error(`Bandcamp's report was missing ${parsed.missingColumns.join(", ")}.`);
  const names = report.accounts.map((a) => a.name).join(", ");
  const dates = parsed.sales.map((s) => s.date).sort();
  const range = dates.length ? ` · ${dates[0]} – ${dates[dates.length - 1]}` : "";
  const { importId, added, duplicates } = await saveSales(orgId, `${API_SYNC_PREFIX} · ${names}${range}`, parsed);
  // Keep only the latest sync that found nothing new: it records when we last checked.
  const empty = await db
    .select()
    .from(imports)
    .where(and(eq(imports.orgId, orgId), eq(imports.addedCount, 0), ne(imports.id, importId)));
  const staleIds = empty.filter((i) => i.filename.startsWith(API_SYNC_PREFIX)).map((i) => i.id);
  if (staleIds.length) await db.delete(imports).where(inArray(imports.id, staleIds));
  return { importId, added, duplicates, names };
}

/** Sync before working on a payout; the outcome goes in the URL so the page can say what happened. */
async function syncOutcome(orgId: string): Promise<Record<string, string>> {
  if (!(await bandcampCredentials(orgId))) return {};
  try {
    return { synced: String((await runSalesSync(orgId)).added) };
  } catch (e) {
    return { syncError: (e as Error).message.slice(0, 200) };
  }
}

export async function syncBandcampSales(_: ActionState, fd: FormData): Promise<ActionState> {
  const { orgId } = await requireAdmin();
  let result;
  try {
    result = await runSalesSync(orgId, str(fd, "from") || undefined);
  } catch (e) {
    return { error: (e as Error).message };
  }
  done();
  if (result.added > 0) redirect(`/import?imported=${result.importId}`);
  return { ok: `Up to date: all ${result.duplicates} sales from ${result.names} were already imported.` };
}

export async function deleteImport(fd: FormData) {
  const { orgId } = await requireAdmin();
  await db.delete(imports).where(and(eq(imports.orgId, orgId), eq(imports.id, int(fd, "id"))));
  done();
}

/** Route every sale with this key to a band / release / track, and remember the choice. */
export async function assignRouting(fd: FormData) {
  const { orgId } = await requireAdmin();
  const key = str(fd, "key");
  const [kind, idStr] = str(fd, "target").split(":");
  const id = Number(idStr);
  if (!key || !kind || !Number.isFinite(id)) throw new Error("Pick where these sales belong");
  let target: { bandId: number; releaseId: number | null; trackId: number | null };
  if (kind === "b") {
    await owned(orgId, bands, id);
    target = { bandId: id, releaseId: null, trackId: null };
  } else if (kind === "r") {
    const [r] = await db
      .select()
      .from(releases)
      .where(and(eq(releases.orgId, orgId), eq(releases.id, id)));
    if (!r) throw new Error("Release not found");
    target = { bandId: r.bandId, releaseId: r.id, trackId: null };
  } else {
    const [t] = await db
      .select()
      .from(tracks)
      .where(and(eq(tracks.orgId, orgId), eq(tracks.id, id)));
    if (!t) throw new Error("Track not found");
    const [r] = await db.select().from(releases).where(eq(releases.id, t.releaseId));
    target = { bandId: t.bandId ?? r.bandId, releaseId: r.id, trackId: t.id };
  }
  await db
    .insert(routingOverrides)
    .values({ orgId, matchKey: key, ...target })
    .onConflictDoUpdate({ target: [routingOverrides.orgId, routingOverrides.matchKey], set: target });
  await reRouteAll(orgId);
  done();
}

export async function deleteRoutingOverride(fd: FormData) {
  const { orgId } = await requireAdmin();
  await db.delete(routingOverrides).where(and(eq(routingOverrides.orgId, orgId), eq(routingOverrides.id, int(fd, "id"))));
  await reRouteAll(orgId);
  done();
}

/** One-click: create a release from an unmatched sale group and route it there. */
export async function createReleaseFromSales(fd: FormData) {
  const { orgId } = await requireAdmin();
  const key = str(fd, "key");
  const bandId = int(fd, "bandId");
  await owned(orgId, bands, bandId);
  const [sample] = await db
    .select()
    .from(sales)
    .where(and(eq(sales.orgId, orgId), eq(sales.routingKey, key)))
    .limit(1);
  if (!sample) return;
  const isTrack = sample.category === "track";
  const url = sample.itemUrl && !isTrack ? sample.itemUrl : null;
  const [{ id: releaseId }] = await db
    .insert(releases)
    .values({ orgId, bandId, title: isTrack ? `${sample.itemName} (single)` : sample.itemName, url })
    .returning({ id: releases.id });
  if (isTrack) {
    const [{ id: trackId }] = await db
      .insert(tracks)
      .values({ orgId, releaseId, title: sample.itemName, url: sample.itemUrl || null, position: 1 })
      .returning({ id: tracks.id });
    if (!sample.itemUrl) {
      await db.insert(routingOverrides).values({ orgId, matchKey: key, bandId, releaseId, trackId }).onConflictDoNothing();
    }
  } else if (!url) {
    await db.insert(routingOverrides).values({ orgId, matchKey: key, bandId, releaseId, trackId: null }).onConflictDoNothing();
  }
  await reRouteAll(orgId);
  done();
}

export async function rerouteAction() {
  const { orgId } = await requireAdmin();
  await reRouteAll(orgId);
  done();
}

// ---------- periods & payouts ----------

async function payoutScope(orgId: string, fd: FormData): Promise<PayoutScope | null> {
  const startDate = isoDate(optStr(fd, "startDate"));
  const endDate = isoDate(optStr(fd, "endDate"));
  if (!startDate || !endDate || startDate > endDate) return null;
  const bandId = optInt(fd, "bandId");
  const [band] = bandId
    ? await db
        .select()
        .from(bands)
        .where(and(eq(bands.orgId, orgId), eq(bands.id, bandId)))
    : [];
  return { bandId: band?.id ?? null, startDate, endDate };
}

/** The preview page's address for a payout. */
function previewUrl(scope: PayoutScope, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({
    ...(scope.bandId ? { band: String(scope.bandId) } : {}),
    from: scope.startDate,
    to: scope.endDate,
    ...extra,
  });
  return `/periods/new?${q}`;
}

/**
 * "Create & review": pull new sales from Bandcamp, then open a preview of the payout. Nothing is
 * stored until it's finalized. (A failed sync doesn't block the preview; the page says so.)
 */
export async function previewPayout(_: ActionState, fd: FormData): Promise<ActionState> {
  const { orgId } = await requireAdmin();
  const scope = await payoutScope(orgId, fd);
  if (!scope) return { error: "Pick a valid start and end date" };
  const sync = await syncOutcome(orgId);
  done();
  redirect(previewUrl(scope, { ...sync, ...(str(fd, "name") ? { name: str(fd, "name") } : {}) }));
}

/** "Sync from Bandcamp" on a preview: pull new sales, then show the preview again. */
export async function resyncPreview(fd: FormData) {
  const { orgId } = await requireAdmin();
  const scope = await payoutScope(orgId, fd);
  if (!scope) redirect("/periods");
  const sync = await syncOutcome(orgId);
  done();
  redirect(previewUrl(scope, { ...sync, ...(str(fd, "name") ? { name: str(fd, "name") } : {}) }));
}

/** Lock in a previewed payout: store the amounts owed to each person, ready to pay. */
export async function finalizePayout(_: ActionState, fd: FormData): Promise<ActionState> {
  const { orgId } = await requireAdmin();
  const scope = await payoutScope(orgId, fd);
  if (!scope) return { error: "Pick a valid start and end date" };
  const { results, summary } = await computePayoutPeriod(orgId, { id: 0, ...scope });
  if (results.length === 0) return { error: "There are no sales to pay in these dates." };
  const problems = results.filter((r) => r.problem).length;
  if (problems > 0 && !bool(fd, "force")) {
    return { error: `${problems} sale(s) aren't assigned to anyone yet. Fix them, or tick "finalize anyway" to leave that money unallocated.` };
  }
  const now = new Date().toISOString();
  const holders = new Set(
    (
      await db
        .select({ id: people.id })
        .from(people)
        .where(and(eq(people.orgId, orgId), eq(people.holdsLabelAccount, true)))
    ).map((p) => p.id),
  );
  const name = str(fd, "name") || (await payoutName(orgId, scope));
  const id = await db.transaction(async (tx) => {
    const [{ id }] = await tx
      .insert(periods)
      .values({
        orgId,
        name,
        ...scope,
        status: "finalized",
        finalizedAt: now,
        snapshot: {
          saleCount: results.length,
          currencies: summary.currencies.map((c) => {
            const s = summary.byCurrency[c];
            return {
              currency: c,
              grossCents: s.grossCents,
              byBand: [...s.byBand].map(([bandId, cents]) => ({ bandId, cents })),
              byDestination: [...s.byDestination].map(([key, cents]) => ({ key, cents })),
              unallocated: s.unallocated,
              problems: s.problems,
            };
          }),
        },
      })
      .returning({ id: periods.id });
    const lines = summary.currencies.flatMap((cur) =>
      [...summary.byCurrency[cur].byPerson]
        .filter(([, p]) => p.total !== 0)
        .map(([personId, p]) => {
          // The label account holder's share is already in the label's account: record it, don't send it.
          const kept = holders.has(personId) && p.total > 0;
          return {
            orgId,
            periodId: id,
            personId,
            currency: cur,
            amountCents: p.total,
            byBand: Object.fromEntries([...p.byBand].map(([b, c]) => [String(b), c])),
            ...(kept ? { status: "kept" as const, paidAt: now } : {}),
          };
        }),
    );
    if (lines.length) await tx.insert(payouts).values(lines);
    return id;
  });
  await syncPeriodStatus(orgId, id);
  done();
  redirect(`/periods/${id}`);
}

/** Undo a finalized payout: its records (paid marks included) are removed and it's a preview again. */
export async function undoFinalize(fd: FormData) {
  const { orgId } = await requireAdmin();
  const [p] = await db
    .delete(periods)
    .where(and(eq(periods.orgId, orgId), eq(periods.id, int(fd, "id"))))
    .returning();
  done();
  redirect(p ? previewUrl(p, { name: p.name }) : "/periods");
}

async function syncAllPeriodStatuses(orgId: string) {
  for (const p of await db.select({ id: periods.id }).from(periods).where(eq(periods.orgId, orgId))) await syncPeriodStatus(orgId, p.id);
}

/** A payout is "paid" once every line is settled: paid, kept in the label account, or nothing owed. */
async function syncPeriodStatus(orgId: string, periodId: number) {
  const rows = await db.select().from(payouts).where(eq(payouts.periodId, periodId));
  const settled = rows.every((r) => r.status !== "pending" || r.amountCents <= 0);
  await db
    .update(periods)
    .set({ status: settled ? "paid" : "finalized" })
    .where(and(eq(periods.orgId, orgId), eq(periods.id, periodId)));
}

/** Mark one payout line paid, kept in the label account, or back to unpaid. */
export async function setPayoutStatus(fd: FormData) {
  const { orgId } = await requireAdmin();
  const status = str(fd, "status");
  if (status !== "pending" && status !== "paid" && status !== "kept") throw new Error("Unknown payout status");
  const [row] = await db
    .update(payouts)
    .set({
      status,
      paidAt: status === "pending" ? null : new Date().toISOString(),
      reference: status === "paid" ? optStr(fd, "reference") : null,
    })
    .where(and(eq(payouts.orgId, orgId), eq(payouts.id, int(fd, "id"))))
    .returning({ periodId: payouts.periodId });
  if (row) await syncPeriodStatus(orgId, row.periodId);
  done();
}

export async function markAllPaid(fd: FormData) {
  const { orgId } = await requireAdmin();
  const periodId = int(fd, "periodId");
  await db
    .update(payouts)
    .set({ status: "paid", paidAt: new Date().toISOString(), reference: optStr(fd, "reference") })
    .where(and(eq(payouts.orgId, orgId), eq(payouts.periodId, periodId), eq(payouts.status, "pending")));
  await syncPeriodStatus(orgId, periodId);
  done();
}

/**
 * Who owns the label's bank account (or nobody). Their share of each payout stays in that account:
 * it's recorded as theirs, but never sent. Their unpaid payouts so far are marked kept too.
 */
export async function setLabelAccountHolder(fd: FormData) {
  const { orgId } = await requireAdmin();
  const personId = optInt(fd, "personId");
  await owned(orgId, people, personId);
  await db.transaction(async (tx) => {
    await tx
      .update(people)
      .set({ holdsLabelAccount: false })
      .where(and(eq(people.orgId, orgId), eq(people.holdsLabelAccount, true)));
    if (!personId) return;
    await tx.update(people).set({ holdsLabelAccount: true }).where(eq(people.id, personId));
    await tx
      .update(payouts)
      .set({ status: "kept", paidAt: new Date().toISOString() })
      .where(and(eq(payouts.personId, personId), eq(payouts.status, "pending"), gt(payouts.amountCents, 0)));
  });
  await syncAllPeriodStatuses(orgId);
  done();
}

// ---------- label funds sent elsewhere ----------

/** Record money the label kept and sent on, e.g. a fundraiser's proceeds to an aid group. */
export async function saveLabelTransfer(_: ActionState, fd: FormData): Promise<ActionState> {
  const { orgId } = await requireAdmin();
  const date = isoDate(optStr(fd, "date"));
  const recipient = str(fd, "recipient");
  const amountCents = parseCents(str(fd, "amount"));
  if (!date) return { error: "Pick the date it was sent" };
  if (!recipient) return { error: "Who received it?" };
  if (!(amountCents > 0)) return { error: "Enter the amount sent" };
  const releaseId = optInt(fd, "releaseId");
  const [release] = releaseId
    ? await db
        .select()
        .from(releases)
        .where(and(eq(releases.orgId, orgId), eq(releases.id, releaseId)))
    : [];
  const bandId = release?.bandId ?? optInt(fd, "bandId");
  await owned(orgId, bands, bandId);
  const values = {
    date,
    recipient,
    amountCents,
    currency: (str(fd, "currency") || "USD").toUpperCase(),
    releaseId: release?.id ?? null,
    // A release implies its band.
    bandId,
    method: optStr(fd, "method"),
    reference: optStr(fd, "reference"),
    note: optStr(fd, "note"),
  };
  const id = optInt(fd, "id");
  if (id) await db.update(labelTransfers).set(values).where(and(eq(labelTransfers.orgId, orgId), eq(labelTransfers.id, id)));
  else await db.insert(labelTransfers).values({ ...values, orgId });
  done();
  return { ok: "Saved" };
}

export async function deleteLabelTransfer(fd: FormData) {
  const { orgId } = await requireAdmin();
  await db.delete(labelTransfers).where(and(eq(labelTransfers.orgId, orgId), eq(labelTransfers.id, int(fd, "id"))));
  done();
}

// ---------- grab bands from a Bandcamp label page ----------

export type LabelArtistRow = LabelArtist & {
  /** new: not in the app yet · linked: already a band · add_url: band exists by name but lacks this URL */
  status: "new" | "linked" | "add_url";
  bandId: number | null;
};

export type LabelLookup = { label: string | null; source: string; artists: LabelArtistRow[] } | { error: string };

export async function findLabelArtists(input: string): Promise<LabelLookup> {
  const { orgId } = await requireAdmin();
  const url = labelArtistsUrl(input);
  if (!url) return { error: "Enter your label's Bandcamp address, e.g. mylabel.bandcamp.com" };
  let html: string;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (label-payouts; reading my own label's artist list)" },
      signal: AbortSignal.timeout(20000),
      redirect: "follow",
    });
    if (res.status === 404) {
      return {
        error: `There’s no artists page at ${url}. That usually means it’s a single artist’s account rather than a label. Use your label’s own Bandcamp address.`,
      };
    }
    if (!res.ok) return { error: `Bandcamp answered ${res.status} for ${url}. Check the address, or try again in a minute.` };
    html = await res.text();
  } catch (e) {
    return { error: `Couldn't reach ${url} (${(e as Error).message}). Are you online?` };
  }
  const artists = parseLabelArtists(html);
  await rememberLabelPhoto(orgId, html);
  if (artists.length === 0) {
    return {
      error: `No artists found at ${url}. Make sure this is a label account (label pages have an “artists” tab), not a single artist's page.`,
    };
  }
  const existing = await allBands(orgId);
  // Fill in photos and locations for bands that are already linked but don't have them yet.
  let backfilled = false;
  for (const a of artists) {
    const b = existing.find((x) => x.urlPatterns.some((p) => p.toLowerCase() === a.urlPattern));
    if (b && ((!b.imageUrl && a.imageUrl) || (!b.location && a.location))) {
      await db
        .update(bands)
        .set({ imageUrl: b.imageUrl ?? a.imageUrl, location: b.location ?? a.location })
        .where(eq(bands.id, b.id));
      backfilled = true;
    }
  }
  if (backfilled) done();
  return {
    label: parseLabelName(html),
    source: url,
    artists: artists.map((a) => {
      const byUrl = existing.find((b) => b.urlPatterns.some((p) => p.toLowerCase() === a.urlPattern));
      if (byUrl) return { ...a, status: "linked", bandId: byUrl.id };
      const n = normalizeText(a.name);
      const byName = existing.find((b) => [b.name, ...b.aliases].some((x) => normalizeText(x) === n));
      if (byName) return { ...a, status: "add_url", bandId: byName.id };
      return { ...a, status: "new", bandId: null };
    }),
  };
}

/** Create the selected bands (or add the Bandcamp URL to ones that already exist by name). */
export async function addLabelArtists(rows: LabelArtistRow[]): Promise<{ added: number; updated: number }> {
  const { orgId } = await requireAdmin();
  let added = 0;
  let updated = 0;
  await db.transaction(async (tx) => {
    for (const r of rows) {
      const current = await tx.select().from(bands).where(eq(bands.orgId, orgId));
      if (r.status === "new") {
        if (current.some((b) => b.urlPatterns.includes(r.urlPattern))) continue;
        await tx.insert(bands).values({ orgId, name: r.name, urlPatterns: [r.urlPattern], location: r.location, imageUrl: r.imageUrl });
        added++;
      } else if (r.status === "add_url" && r.bandId) {
        const b = current.find((x) => x.id === r.bandId);
        if (b && !b.urlPatterns.includes(r.urlPattern)) {
          await tx
            .update(bands)
            .set({
              urlPatterns: [...b.urlPatterns, r.urlPattern],
              location: b.location ?? r.location,
              imageUrl: b.imageUrl ?? r.imageUrl,
            })
            .where(eq(bands.id, b.id));
          updated++;
        }
      }
    }
  });
  await reRouteAll(orgId);
  done();
  return { added, updated };
}

// ---------- grab releases from a Bandcamp label page ----------

export type LabelReleaseRow = LabelRelease & {
  /** Credited to the label itself (a label tape, a compilation): filed under the label's own band. */
  labelRelease: boolean;
  bandId: number | null;
  /** The band it will be filed under: an existing band, or the artist name for a band that will be created. */
  bandName: string;
  releaseId: number | null;
  status: "new" | "imported";
};

export type ReleaseLookup =
  | { label: string | null; source: string; labelHost: string; releases: LabelReleaseRow[] }
  | { error: string };

export async function findLabelReleases(input: string): Promise<ReleaseLookup> {
  const { orgId } = await requireAdmin();
  const url = labelMusicUrl(input);
  const merchUrl = labelMerchUrl(input);
  if (!url || !merchUrl) return { error: "Enter your label's Bandcamp address, e.g. mylabel.bandcamp.com" };
  const [page, merchPage] = await Promise.all([fetchPage(url), fetchPage(merchUrl)]);
  if ("error" in page) {
    return {
      error:
        page.status === 404
          ? `There’s no music page at ${url}. Check the address.`
          : `${page.error}. Check the address, or try again in a minute.`,
    };
  }
  const labelName = parseLabelName(page.html);
  await rememberLabelPhoto(orgId, page.html);
  const found = parseLabelMusic(page.html, url);
  // Standalone merch. With only one item, Bandcamp redirects /merch straight to that item's page;
  // with none (or only formats of releases) it redirects to an album, which has nothing to add.
  if (!("error" in merchPage)) {
    if (/\/merch\/[^/]+/.test(merchPage.finalUrl)) {
      const d = parseReleasePage(merchPage.html, merchPage.finalUrl);
      if (d) found.push({ bandcampId: d.bandcampId, kind: "merch", title: d.title, artist: d.artist, url: d.url, artUrl: d.artUrl });
    } else {
      found.push(...parseLabelMerch(merchPage.html, merchUrl));
    }
  }
  if (found.length === 0) return { error: `No releases or merch found at ${url}.` };
  // Items on the label's own page with no artist credit are the label's own (logo shirts, compilations).
  for (const r of found) if (!r.artist && hostOf(r.url) === hostOf(url)) r.artist = labelName;
  const labelHost = hostOf(url);
  const bandRows = await allBands(orgId);
  const rows: LabelReleaseRow[] = [];
  for (const r of found) {
    const band = findBandFor(r.url, r.artist, labelHost, bandRows);
    const existing = await findExistingRelease(orgId, r, band?.id ?? null);
    const bandId = existing?.bandId ?? band?.id ?? null;
    rows.push({
      ...r,
      labelRelease: !!labelName && !!r.artist && normalizeText(r.artist) === normalizeText(labelName),
      bandId,
      bandName: (bandId && bandRows.find((b) => b.id === bandId)?.name) || "",
      releaseId: existing?.id ?? null,
      status: existing ? "imported" : "new",
    });
  }

  // Artists that aren't bands yet: releases on the same Bandcamp page belong together
  // ("Amen Dunes" and "Amen Dunes feat. Westerman"), named after the most common artist credit.
  // Releases hosted on the label's own page are grouped by artist name.
  const groupKey = (r: LabelRelease) => {
    const host = hostOf(r.url);
    return host && host !== labelHost ? `host:${host}` : `artist:${normalizeText(r.artist ?? "")}`;
  };
  const credits = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (r.bandId) continue;
    const m = credits.get(groupKey(r)) ?? new Map<string, number>();
    const name = r.artist ?? "Unknown artist";
    m.set(name, (m.get(name) ?? 0) + 1);
    credits.set(groupKey(r), m);
  }
  const nameFor = (key: string) =>
    [...(credits.get(key) ?? new Map())].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] ?? "Unknown artist";
  for (const r of rows) if (!r.bandId) r.bandName = nameFor(groupKey(r));

  return { label: labelName, source: url, labelHost, releases: rows };
}

export type ReleaseImportResult =
  | { ok: true; title: string; tracks: number; createdBand: string | null; created: boolean; compilation: boolean }
  | { ok: false; title: string; error: string };

type ReleaseImportRow = {
  url: string;
  title: string;
  artist: string | null;
  /** Name to give the band if it has to be created. */
  bandName: string;
  bandId: number | null;
  releaseId: number | null;
};

/** How many release pages the server fetches at once. Kept low to be polite to Bandcamp. */
const FETCH_CONCURRENCY = 3;

/**
 * Fetch a batch of release pages and save them. The client sends small batches one after another
 * (Next.js runs server actions sequentially) so it can show progress, then calls
 * finishReleaseImport() once at the end.
 */
export async function importBandcampReleases(
  rows: ReleaseImportRow[],
  labelHost: string,
  labelName: string | null = null,
): Promise<ReleaseImportResult[]> {
  const { orgId } = await requireAdmin();
  const results: ReleaseImportResult[] = new Array(rows.length);
  // Pages are fetched in parallel, but saved one at a time, so two releases by a new artist can't
  // both create the band.
  let saving = Promise.resolve();
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const i = next++;
      try {
        const page = await fetchPage(rows[i].url);
        const save = saving.then(() => importOne(orgId, rows[i], page, labelHost, labelName));
        saving = save.then(
          () => {},
          () => {},
        );
        results[i] = await save;
      } catch (e) {
        results[i] = { ok: false, title: rows[i].title, error: (e as Error).message };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, rows.length) }, worker));
  return results;
}

async function importOne(
  orgId: string,
  row: ReleaseImportRow,
  page: Awaited<ReturnType<typeof fetchPage>>,
  labelHost: string,
  labelName: string | null,
): Promise<ReleaseImportResult> {
  if ("error" in page) return { ok: false, title: row.title, error: page.error };
  const details = parseReleasePage(page.html, row.url);
  if (!details) return { ok: false, title: row.title, error: "No release data on the page (private or removed?)" };

  let createdBand: string | null = null;
  const bandRows = await allBands(orgId);
  let bandId = row.bandId && bandRows.some((b) => b.id === row.bandId) ? row.bandId : null;
  if (!bandId) {
    const artist = row.bandName || details.artist || row.artist || "Unknown artist";
    const isLabel = !!labelName && normalizeText(artist) === normalizeText(labelName);
    const found = findBandFor(details.url, artist, labelHost, bandRows);
    const band = found ?? (await createBandFor(orgId, details.url, artist, labelHost, isLabel));
    if (found && isLabel && !found.isLabel) await db.update(bands).set({ isLabel: true }).where(eq(bands.id, found.id));
    // The label's own band doesn't need members, so it isn't reported as a new band to set up.
    if (!found && !isLabel) createdBand = band.name;
    bandId = band.id;
  }
  // Pages on the label's own account show the label's profile photo.
  if (hostOf(details.url) === labelHost) await rememberLabelPhoto(orgId, page.html);
  const existing = row.releaseId ?? (await findExistingRelease(orgId, details, bandId))?.id ?? null;
  await owned(orgId, releases, existing);
  const res = await upsertRelease(orgId, details, bandId, existing);
  return { ok: true, title: details.title, tracks: res.tracks, createdBand, created: res.created, compilation: res.compilation };
}

/** After an import: re-match sales, and report how many outside artists still need a contact. */
export async function finishReleaseImport(): Promise<{ needContacts: number }> {
  const { orgId } = await requireAdmin();
  await reRouteAll(orgId);
  done();
  return { needContacts: await outsideArtistsNeedingContact(orgId) };
}

async function outsideArtistsNeedingContact(orgId: string) {
  const [trackRows, artists] = await Promise.all([
    db.select({ outsideArtistId: tracks.outsideArtistId }).from(tracks).where(eq(tracks.orgId, orgId)),
    db.select().from(outsideArtists).where(eq(outsideArtists.orgId, orgId)),
  ]);
  const used = new Set(trackRows.map((t) => t.outsideArtistId));
  return artists.filter((a) => used.has(a.id) && !a.contactPersonId && !a.dismissed).length;
}

/**
 * The one-line contact for an artist who isn't on the label: who to pay for their tracks.
 * Reuses an existing person with the same email (or name), otherwise creates one.
 */
export async function saveOutsideArtistContact(fd: FormData) {
  const { orgId } = await requireAdmin();
  const artistId = int(fd, "artistId");
  const [artist] = await db
    .select()
    .from(outsideArtists)
    .where(and(eq(outsideArtists.orgId, orgId), eq(outsideArtists.id, artistId)));
  if (!artist) throw new Error("Artist not found");
  const name = str(fd, "name") || artist.name;
  const email = optStr(fd, "email");
  const existing = await findExistingPerson(orgId, name, email);
  let personId = existing?.id;
  if (!personId) {
    [{ id: personId }] = await db
      .insert(people)
      .values({ orgId, name, email, notes: `Contact for ${artist.name}` })
      .returning({ id: people.id });
  }
  if (existing && email && !existing.email) await db.update(people).set({ email }).where(eq(people.id, existing.id));
  await db.update(outsideArtists).set({ contactPersonId: personId, dismissed: false }).where(eq(outsideArtists.id, artistId));
  done();
}

/** Don't pay an outside artist (e.g. a donated track): the label keeps their share. Or undo that. */
export async function setOutsideArtistDismissed(fd: FormData) {
  const { orgId } = await requireAdmin();
  const dismissed = bool(fd, "dismissed");
  const ids = fd.getAll("artistId").map(Number).filter(Number.isFinite);
  if (ids.length) {
    await db
      .update(outsideArtists)
      .set({ dismissed })
      .where(and(eq(outsideArtists.orgId, orgId), inArray(outsideArtists.id, ids)));
  }
  done();
}

export async function clearOutsideArtistContact(fd: FormData) {
  const { orgId } = await requireAdmin();
  await db
    .update(outsideArtists)
    .set({ contactPersonId: null })
    .where(and(eq(outsideArtists.orgId, orgId), eq(outsideArtists.id, int(fd, "artistId"))));
  done();
}

/** "refresh from Bandcamp" on a release page. */
export async function refreshReleaseFromBandcamp(_: ActionState, fd: FormData): Promise<ActionState> {
  const { orgId } = await requireAdmin();
  const [r] = await db
    .select()
    .from(releases)
    .where(and(eq(releases.orgId, orgId), eq(releases.id, int(fd, "id"))));
  if (!r?.url) return { error: "This release has no Bandcamp URL. Add one under release details first." };
  const page = await fetchPage(r.url);
  if ("error" in page) return { error: page.error };
  const details = parseReleasePage(page.html, r.url);
  if (!details) return { error: "Couldn't read release data from that page." };
  const res = await upsertRelease(orgId, details, r.bandId, r.id);
  await reRouteAll(orgId);
  done();
  return { ok: `Updated from Bandcamp: ${res.tracks} tracks${res.addedTracks ? `, ${res.addedTracks} new` : ""}.` };
}

/**
 * The quick "+ cost" on one physical format (or standalone merch item): a fixed amount per item
 * sold, either withheld or paid to a person. Everything else is implied by the row it came from.
 */
export async function saveItemCost(fd: FormData) {
  const { orgId } = await requireAdmin();
  const releaseId = int(fd, "releaseId");
  const [release] = await db
    .select()
    .from(releases)
    .where(and(eq(releases.orgId, orgId), eq(releases.id, releaseId)));
  if (!release) throw new Error("Release not found");
  const packageId = optInt(fd, "packageId");
  const amountCents = Math.round(Number.parseFloat(str(fd, "amount")) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) throw new Error("Enter the cost per item");
  const payTo = str(fd, "payTo");
  const personId = payTo === "withheld" ? null : Number(payTo) || null;
  await owned(orgId, people, personId);
  const pkg = packageId ? release.packages.find((p) => p.bandcampId === packageId) : undefined;
  await db.insert(deductions).values({
    orgId,
    label: `${pkg?.title ?? release.title} cost`,
    kind: "per_unit",
    amountCents,
    currency: str(fd, "currency").toUpperCase() || pkg?.currency || "USD",
    destination: personId ? "person" : "expense",
    personId,
    bandId: release.bandId,
    releaseId,
    packageId,
    itemCategory: "merch",
  });
  done();
}
