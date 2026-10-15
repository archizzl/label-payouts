import "server-only";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { possessive } from "@/lib/plural";
import { managingLabel, subAccountFor } from "./band-accounts";

/*
 * A band account the label made can keep its own books as well: sales that don't go through the
 * label, with their own splits, payouts and receipts, under the band account's own orgId (its
 * Settings turns them on). Its own band is one row in those books, and its people are the label's
 * band's members, copied over and kept in step: the label's books say who's in the band, and each
 * person's name and how they're paid are the same in both (people.labelPersonId links the two).
 */

const { accountSettings, bandLoginPeople, bandMemberships, bands, people } = schema;

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
  if (!m) throw new Error("Only a band account a label made has books of its own to turn on.");
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
 * that band's sales would come into both books and be paid out twice. Goes by what each API access
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
  return `${possessive(managed.labelName)} Bandcamp API access also reaches ${list}, so ${names.length === 1 ? "its" : "their"} sales would come into both books and be paid out twice.`;
}
