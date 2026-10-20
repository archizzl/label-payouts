import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, min, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { BAND_GROUP_VIA, MANUAL_IMPORT, MANUAL_VIA } from "@/lib/manual-sales";
import { possessive } from "@/lib/plural";
import { routeSale } from "@/lib/routing";
import { managingLabel, subAccountFor } from "./band-accounts";
import { computeAllTime, loadCatalog } from "./data";
import { importNamed } from "./import-rows";
import { paidSaleIds } from "./sales-browse";
import { summarize } from "@/lib/splits";

/*
 * A band account the label made can keep its own books as well: sales that don't go through the
 * label, with their own splits, payouts and receipts, under the band account's own orgId (its
 * Settings turns them on). Its own band is one row in those books, and its people are the label's
 * band's members, copied over and kept in step: the label's books say who's in the band, and each
 * person's name and how they're paid are the same in both (people.labelPersonId links the two).
 *
 * Its sales from its time on the label are the label's, though: they go into the label's books for
 * its band (moveSalesToLabel), and its own books keep just what came before.
 */

const { accountSettings, bandLoginPeople, bandMemberships, bands, people, sales } = schema;

/** The details that are the same in both books. */
const SHARED = ["name", "email", "paypalMe", "venmo", "cashtag"] as const;
type Shared = Pick<typeof people.$inferSelect, (typeof SHARED)[number]>;
const shared = (p: Shared): Shared => ({ name: p.name, email: p.email, paypalMe: p.paypalMe, venmo: p.venmo, cashtag: p.cashtag });

/** The band's own band row in its own books, if it has one (the first, as with any band account). */
async function ownBandRow(bandOrgId: string) {
  const [row] = await db
    .select({ id: bands.id, name: bands.name })
    .from(bands)
    .where(and(eq(bands.orgId, bandOrgId), eq(bands.isLabel, false)))
    .orderBy(asc(bands.id))
    .limit(1);
  return row ?? null;
}

/**
 * Turn a label-made band account's own books on or off. On: its band in its own books (named as the
 * label has it) and its people are made if they aren't there yet. Off hides them; nothing is deleted.
 */
export async function setOwnBooks(bandOrgId: string, on: boolean) {
  const m = await managingLabel(bandOrgId);
  if (!m) throw new Error("Only a band group a label made has books of its own to turn on.");
  await db.insert(accountSettings).values({ orgId: bandOrgId, ownBooks: on }).onConflictDoUpdate({ target: accountSettings.orgId, set: { ownBooks: on } });
  if (!on) return;
  if (!(await ownBandRow(bandOrgId))) {
    const [band] = await db.select({ name: bands.name }).from(bands).where(and(eq(bands.orgId, m.labelOrgId), eq(bands.id, m.bandId)));
    await db.insert(bands).values({ orgId: bandOrgId, name: band?.name ?? m.labelName });
  }
  await syncOwnPeople(bandOrgId);
}

/**
 * Bring a band account's own books' people in step with the label's band: each current member there
 * is a current member here too, with the same roles, name and payment details, and linked to their
 * own login on the band account if they have one. Someone who left the band in the label's books
 * stays here (with their history), no longer current. Does nothing while own books are off.
 */
export async function syncOwnPeople(bandOrgId: string) {
  const m = await managingLabel(bandOrgId);
  if (!m?.ownBooks) return;
  const band = await ownBandRow(bandOrgId);
  if (!band) return;
  const [labelMembers, logins, ownPeople, ownMemberships] = await Promise.all([
    db
      .select({ person: people, roles: bandMemberships.roles, active: bandMemberships.active })
      .from(bandMemberships)
      .innerJoin(people, eq(people.id, bandMemberships.personId))
      .where(and(eq(bandMemberships.orgId, m.labelOrgId), eq(bandMemberships.bandId, m.bandId))),
    db.select().from(bandLoginPeople).where(eq(bandLoginPeople.orgId, bandOrgId)),
    db.select().from(people).where(eq(people.orgId, bandOrgId)),
    db.select().from(bandMemberships).where(and(eq(bandMemberships.orgId, bandOrgId), eq(bandMemberships.bandId, band.id))),
  ]);
  const loginOf = new Map(logins.map((l) => [l.personId, l.userId]));
  const current = new Set<number>();
  for (const { person, roles, active } of labelMembers) {
    let mine = ownPeople.find((p) => p.labelPersonId === person.id);
    // Someone who left before own books were turned on doesn't need a record here.
    if (!mine && !active) continue;
    const values = { ...shared(person), userId: loginOf.get(person.id) ?? null };
    if (!mine) {
      [mine] = await db
        .insert(people)
        .values({ ...values, orgId: bandOrgId, labelPersonId: person.id })
        .returning();
    } else if (SHARED.some((k) => mine![k] !== person[k]) || mine.userId !== values.userId) {
      await db.update(people).set(values).where(eq(people.id, mine.id));
    }
    if (active) current.add(mine.id);
    const membership = ownMemberships.find((x) => x.personId === mine!.id);
    if (!membership) {
      await db.insert(bandMemberships).values({ orgId: bandOrgId, bandId: band.id, personId: mine.id, roles, active });
    } else if (membership.active !== active || membership.roles.join("\n") !== roles.join("\n")) {
      await db.update(bandMemberships).set({ roles, active }).where(eq(bandMemberships.id, membership.id));
    }
  }
  // Members of the own band who aren't current members in the label's books any more.
  const gone = ownMemberships.filter((x) => x.active && !current.has(x.personId)).map((x) => x.id);
  if (gone.length) await db.update(bandMemberships).set({ active: false }).where(inArray(bandMemberships.id, gone));
}

/** A band's members changed in the label's books: its own books (if it keeps them) follow. */
export async function syncOwnPeopleForBand(labelOrgId: string, bandId: number) {
  const sub = await subAccountFor(labelOrgId, bandId);
  if (sub) await syncOwnPeople(sub.org.id);
}

/** The same people in the other books: own-books records for label payees, and the label's for own-books ones. */
export async function counterpartIds(ids: number[]): Promise<number[]> {
  if (!ids.length) return [];
  const rows = await db
    .select({ id: people.id, labelPersonId: people.labelPersonId })
    .from(people)
    .where(or(inArray(people.labelPersonId, ids), inArray(people.id, ids)));
  const out = new Set<number>();
  for (const r of rows) {
    if (r.labelPersonId != null && ids.includes(r.labelPersonId)) out.add(r.id);
    if (ids.includes(r.id) && r.labelPersonId != null) out.add(r.labelPersonId);
  }
  for (const id of ids) out.delete(id);
  return [...out];
}

/** Someone's name or payment details changed in one set of books: the other follows. */
export async function shareDetails(personId: number, details: Partial<Shared>) {
  const set = Object.fromEntries(Object.entries(details).filter(([k, v]) => v !== undefined && (SHARED as readonly string[]).includes(k)));
  if (!Object.keys(set).length) return;
  const others = await counterpartIds([personId]);
  if (others.length) await db.update(people).set(set).where(inArray(people.id, others));
}

/**
 * A warning when the band's own Bandcamp API access reaches a Bandcamp band the label's also reaches:
 * that band's sales could come into both books and be paid out twice. (The own books' sync leaves
 * out sales the label's books already have, but not ones it brings in before the label's sync does.) Goes by what each API access
 * last reported (Test connection and the hourly sync note it). Null when there's no overlap.
 */
export async function bothBooksWarning(bandOrgId: string): Promise<string | null> {
  const managed = await managingLabel(bandOrgId);
  if (!managed) return null;
  const rows = await db
    .select({ orgId: accountSettings.orgId, bands: accountSettings.bandcampBands })
    .from(accountSettings)
    .where(inArray(accountSettings.orgId, [bandOrgId, managed.labelOrgId]));
  const own = rows.find((r) => r.orgId === bandOrgId)?.bands ?? [];
  const labelIds = new Set((rows.find((r) => r.orgId === managed.labelOrgId)?.bands ?? []).map((b) => b.id));
  const names = [...new Set(own.filter((b) => labelIds.has(b.id)).map((b) => b.name))];
  if (!names.length) return null;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${possessive(managed.labelName)} Bandcamp API access also reaches ${list}, so ${names.length === 1 ? "its" : "their"} sales could come into both books and be paid out twice.`;
}

/**
 * Of these sales (by dedupe key, which is made from the Bandcamp transaction), the ones already in
 * the books of a label this band account is with (one that made it, or one it connected its own
 * account to), for its own books to leave out: otherwise they'd be paid twice. Empty for any other
 * account.
 */
export async function alreadyInLabelBooks(bandOrgId: string, dedupeKeys: string[]) {
  const found = new Set<string>();
  const labels = await db
    .select({ labelOrgId: schema.accountLinks.labelOrgId, labelName: schema.organization.name })
    .from(schema.accountLinks)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.accountLinks.labelOrgId))
    .where(and(eq(schema.accountLinks.bandOrgId, bandOrgId), eq(schema.accountLinks.status, "active")));
  if (!labels.length) return { found, labelName: null };
  const labelIds = labels.map((l) => l.labelOrgId);
  for (let i = 0; i < dedupeKeys.length; i += 500) {
    const rows = await db
      .select({ k: sales.dedupeKey })
      .from(sales)
      .where(and(inArray(sales.orgId, labelIds), inArray(sales.dedupeKey, dedupeKeys.slice(i, i + 500))));
    for (const r of rows) found.add(r.k);
  }
  const names = labels.map((l) => l.labelName);
  return { found, labelName: names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` };
}

/**
 * The label's payouts that paid a band's members, with just the band's part of each (a whole-label
 * payout pays other bands too): for a band account the label made, beside its own payouts.
 */
export async function labelPayoutsFor(labelOrgId: string, bandId: number) {
  const periodRows = await db
    .select()
    .from(schema.periods)
    .where(and(eq(schema.periods.orgId, labelOrgId), or(eq(schema.periods.bandId, bandId), isNull(schema.periods.bandId))))
    .orderBy(desc(schema.periods.startDate));
  const payoutRows = periodRows.length
    ? await db
        .select()
        .from(schema.payouts)
        .where(and(eq(schema.payouts.orgId, labelOrgId), inArray(schema.payouts.periodId, periodRows.map((p) => p.id))))
    : [];
  return periodRows
    .map((period) => {
      const byCurrency = new Map<string, { total: number; paid: number }>();
      for (const p of payoutRows) {
        const cents = p.periodId === period.id ? (p.byBand[String(bandId)] ?? 0) : 0;
        if (!cents) continue;
        const e = byCurrency.get(p.currency) ?? { total: 0, paid: 0 };
        e.total += cents;
        if (p.status !== "pending") e.paid += cents;
        byCurrency.set(p.currency, e);
      }
      return { period, byCurrency };
    })
    .filter((r) => r.byCurrency.size > 0);
}

/**
 * What the label has for one of its bands, all-time: its sales' split (this band's only), what its
 * band fund paid for, and the payouts that paid its members. For the band account's dashboard.
 */
export async function labelPartFor(labelOrgId: string, bandId: number) {
  const [{ results }, fundsSpent, payouts] = await Promise.all([
    computeAllTime(labelOrgId),
    db
      .select({ currency: schema.expenses.currency, amountCents: schema.expenses.amountCents })
      .from(schema.expenses)
      .where(
        and(
          eq(schema.expenses.orgId, labelOrgId),
          eq(schema.expenses.bandId, bandId),
          eq(schema.expenses.status, "approved"),
          eq(schema.expenses.paidBy, "band_fund"),
        ),
      ),
    labelPayoutsFor(labelOrgId, bandId),
  ]);
  return { summary: summarize(results.filter((r) => r.bandId === bandId)), fundsSpent, payouts };
}

/**
 * When a band came to its label, as far as its sales go: the label's first sale for it, or when the
 * label made its group, whichever is earlier. Null when neither is known.
 */
export async function onLabelSince(labelOrgId: string, bandId: number): Promise<string | null> {
  const [[first], [link]] = await Promise.all([
    db
      .select({ date: min(sales.date) })
      .from(sales)
      .where(and(eq(sales.orgId, labelOrgId), eq(sales.bandId, bandId))),
    db
      .select({ at: schema.accountLinks.acceptedAt })
      .from(schema.accountLinks)
      .where(and(eq(schema.accountLinks.labelOrgId, labelOrgId), eq(schema.accountLinks.labelBandId, bandId))),
  ]);
  const dates = [first?.date, link?.at?.slice(0, 10)].filter((d): d is string => !!d).sort();
  return dates[0] ?? null;
}

/**
 * A band account the label made: its sales from its time on the label (imported, synced or added
 * by hand) go into the label's books for its band, to be split and paid out there. Ones the label's
 * books already have (from the label's own Bandcamp) are dropped instead, and ones its own payouts
 * paid stay. In the label's catalog, a sale is matched as usual if that finds the band; otherwise
 * it's the band's with no release. Returns how many moved.
 */
export async function moveSalesToLabel(bandOrgId: string): Promise<number> {
  const m = await managingLabel(bandOrgId);
  if (!m) return 0;
  const since = await onLabelSince(m.labelOrgId, m.bandId);
  const rows = await db
    .select({
      id: sales.id,
      dedupeKey: sales.dedupeKey,
      itemUrl: sales.itemUrl,
      artist: sales.artist,
      itemName: sales.itemName,
      packageName: sales.packageName,
      category: sales.category,
      routedVia: sales.routedVia,
      catalogNumber: sql<string | null>`${sales.raw}->>'catalog number'`,
      upc: sql<string | null>`${sales.raw}->>'upc'`,
      isrc: sql<string | null>`${sales.raw}->>'isrc'`,
    })
    .from(sales)
    .where(and(eq(sales.orgId, bandOrgId), since ? gte(sales.date, since) : undefined));
  if (!rows.length) return 0;
  const paid = await paidSaleIds(
    bandOrgId,
    rows.map((r) => r.id),
  );
  const todo = rows.filter((r) => !paid.has(r.id));
  if (!todo.length) return 0;
  const { found: there } = await alreadyInLabelBooks(
    bandOrgId,
    todo.map((r) => r.dedupeKey),
  );
  const [catalog, [group]] = await Promise.all([
    loadCatalog(m.labelOrgId),
    db.select({ name: schema.organization.name }).from(schema.organization).where(eq(schema.organization.id, bandOrgId)),
  ]);
  const handAdded = todo.some((r) => r.routedVia === MANUAL_VIA) ? await importNamed(m.labelOrgId, MANUAL_IMPORT) : null;
  const imported = todo.some((r) => r.routedVia !== MANUAL_VIA) ? await importNamed(m.labelOrgId, `From ${group?.name ?? "the band"}`) : null;
  await db.transaction(async (tx) => {
    const dupes = todo.filter((r) => there.has(r.dedupeKey)).map((r) => r.id);
    if (dupes.length) await tx.delete(sales).where(inArray(sales.id, dupes));
    for (const r of todo.filter((x) => !there.has(x.dedupeKey))) {
      const route =
        r.routedVia === MANUAL_VIA
          ? { bandId: m.bandId, releaseId: null, trackId: null, via: MANUAL_VIA }
          : (() => {
              const found = routeSale({ ...r, catalogNumber: r.catalogNumber ?? undefined, upc: r.upc ?? undefined, isrc: r.isrc ?? undefined }, catalog);
              return found.bandId === m.bandId ? found : { bandId: m.bandId, releaseId: null, trackId: null, via: BAND_GROUP_VIA };
            })();
      await tx
        .update(sales)
        .set({
          orgId: m.labelOrgId,
          importId: r.routedVia === MANUAL_VIA ? handAdded! : imported!,
          bandId: route.bandId,
          releaseId: route.releaseId,
          trackId: route.trackId,
          routedVia: route.via,
        })
        .where(eq(sales.id, r.id));
    }
  });
  return todo.length;
}

/**
 * A label's band groups that still have sales of their own: what's from their time on the label
 * comes in (for the hourly sync; new ones come in as they're added). Returns how many moved.
 */
export async function moveBandGroupsSales(labelOrgId: string): Promise<number> {
  const groups = await db
    .selectDistinct({ orgId: sales.orgId })
    .from(schema.accountLinks)
    .innerJoin(sales, eq(sales.orgId, schema.accountLinks.bandOrgId))
    .where(and(eq(schema.accountLinks.labelOrgId, labelOrgId), eq(schema.accountLinks.managed, true), eq(schema.accountLinks.status, "active")));
  let moved = 0;
  for (const g of groups) moved += await moveSalesToLabel(g.orgId);
  return moved;
}
