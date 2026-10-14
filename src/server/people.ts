import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";

const { people, bandMemberships, splitShares, deductions, payouts, outsideArtists } = schema;

type Person = typeof people.$inferSelect;

export const normalizeEmail = (e: string | null | undefined) => (e ?? "").trim().toLowerCase();
export const normalizeName = (n: string) => n.trim().toLowerCase().replace(/\s+/g, " ").replace(/[’`]/g, "'");

/**
 * Merge person `fromId` into `intoId` (both in this account): everything that pointed at `from` now
 * points at `into`, and `from` is deleted. Where both had something (the same band, the same split,
 * the same payout period), they're combined rather than duplicated. Missing contact details are
 * copied over.
 */
export async function mergePeople(orgId: string, intoId: number, fromId: number) {
  if (intoId === fromId) return;
  await db.transaction(async (tx) => {
    const [into] = await tx.select().from(people).where(and(eq(people.orgId, orgId), eq(people.id, intoId)));
    const [from] = await tx.select().from(people).where(and(eq(people.orgId, orgId), eq(people.id, fromId)));
    if (!into || !from) throw new Error("Person not found");

    // Contact details: keep what `into` has, fill gaps from `from`. A login stays linked either way.
    await tx
      .update(people)
      .set({
        userId: into.userId ?? from.userId,
        email: into.email || from.email,
        paypalMe: into.paypalMe || from.paypalMe,
        venmo: into.venmo || from.venmo,
        cashtag: into.cashtag || from.cashtag,
        notes: [into.notes, from.notes].filter(Boolean).join("\n") || null,
        holdsLabelAccount: into.holdsLabelAccount || from.holdsLabelAccount,
      })
      .where(eq(people.id, intoId));

    // Band memberships: one per band; merge roles, and stay current if either was.
    const intoBands = new Map((await tx.select().from(bandMemberships).where(eq(bandMemberships.personId, intoId))).map((m) => [m.bandId, m]));
    for (const m of await tx.select().from(bandMemberships).where(eq(bandMemberships.personId, fromId))) {
      const existing = intoBands.get(m.bandId);
      if (existing) {
        await tx
          .update(bandMemberships)
          .set({ roles: [...new Set([...existing.roles, ...m.roles])], active: existing.active || m.active })
          .where(eq(bandMemberships.id, existing.id));
        await tx.delete(bandMemberships).where(eq(bandMemberships.id, m.id));
      } else {
        await tx.update(bandMemberships).set({ personId: intoId }).where(eq(bandMemberships.id, m.id));
      }
    }

    // Split shares: if both were in the same split, add their shares together.
    const intoShares = new Map((await tx.select().from(splitShares).where(eq(splitShares.personId, intoId))).map((s) => [s.ruleId, s]));
    for (const s of await tx.select().from(splitShares).where(eq(splitShares.personId, fromId))) {
      const existing = intoShares.get(s.ruleId);
      if (existing) {
        await tx
          .update(splitShares)
          .set({ bps: existing.bps + s.bps })
          .where(eq(splitShares.id, existing.id));
        await tx.delete(splitShares).where(eq(splitShares.id, s.id));
      } else {
        await tx.update(splitShares).set({ personId: intoId }).where(eq(splitShares.id, s.id));
      }
    }

    // Costs paid to them, and outside artists they're the contact for.
    await tx.update(deductions).set({ personId: intoId }).where(eq(deductions.personId, fromId));
    await tx.update(outsideArtists).set({ contactPersonId: intoId }).where(eq(outsideArtists.contactPersonId, fromId));

    // Payouts: one line per period and currency. Combine amounts and per-band breakdowns; a
    // combined line is only settled if both were.
    const intoPayouts = await tx.select().from(payouts).where(eq(payouts.personId, intoId));
    for (const p of await tx.select().from(payouts).where(eq(payouts.personId, fromId))) {
      const existing = intoPayouts.find((x) => x.periodId === p.periodId && x.currency === p.currency);
      if (!existing) {
        await tx.update(payouts).set({ personId: intoId }).where(eq(payouts.id, p.id));
        continue;
      }
      const byBand = { ...existing.byBand };
      for (const [band, cents] of Object.entries(p.byBand)) byBand[band] = (byBand[band] ?? 0) + cents;
      // Settled (paid, or kept in the label account) only if both were.
      const bothSettled = existing.status !== "pending" && p.status !== "pending";
      await tx
        .update(payouts)
        .set({
          amountCents: existing.amountCents + p.amountCents,
          byBand,
          status: bothSettled ? existing.status : "pending",
          paidAt: bothSettled ? existing.paidAt : null,
          reference: [existing.reference, p.reference].filter(Boolean).join(", ") || null,
        })
        .where(eq(payouts.id, existing.id));
      await tx.delete(payouts).where(eq(payouts.id, p.id));
    }

    await tx.delete(people).where(eq(people.id, fromId));
  });
}

/** Which of two duplicate records to keep: the one with more history, then the older one. */
async function keeper(a: Person, b: Person): Promise<[Person, Person]> {
  const weight = async (p: Person) => {
    const [pay, shares, bands] = await Promise.all([
      db.select({ id: payouts.id }).from(payouts).where(eq(payouts.personId, p.id)),
      db.select({ id: splitShares.id }).from(splitShares).where(eq(splitShares.personId, p.id)),
      db.select({ id: bandMemberships.id }).from(bandMemberships).where(eq(bandMemberships.personId, p.id)),
    ]);
    // Someone who has a login linked is the record to keep.
    return (p.userId ? 1000 : 0) + pay.length * 100 + shares.length * 10 + bands.length;
  };
  const [wa, wb] = await Promise.all([weight(a), weight(b)]);
  return wa !== wb ? (wa > wb ? [a, b] : [b, a]) : a.id < b.id ? [a, b] : [b, a];
}

/**
 * People sharing an email address are the same person (they'd be paid to the same PayPal
 * account), so they're merged automatically. Returns the names that were merged.
 */
export async function autoMergeByEmail(orgId: string): Promise<string[]> {
  const merged: string[] = [];
  for (;;) {
    const all = await db.select().from(people).where(eq(people.orgId, orgId));
    const byEmail = new Map<string, Person>();
    let pair: [Person, Person] | null = null;
    for (const p of all) {
      const e = normalizeEmail(p.email);
      if (!e) continue;
      const other = byEmail.get(e);
      if (other) {
        pair = [other, p];
        break;
      }
      byEmail.set(e, p);
    }
    if (!pair) return merged;
    const [keep, drop] = await keeper(...pair);
    await mergePeople(orgId, keep.id, drop.id);
    merged.push(keep.name);
  }
}

/** People who share a name or an email: probably (or, for email, certainly) the same person. */
export async function possibleDuplicates(orgId: string): Promise<Person[][]> {
  const all = await db.select().from(people).where(eq(people.orgId, orgId));
  const parent = new Map(all.map((p) => [p.id, p.id]));
  const find = (id: number): number => (parent.get(id) === id ? id : find(parent.get(id)!));
  const link = (key: (p: Person) => string) => {
    const seen = new Map<string, number>();
    for (const p of all) {
      const k = key(p);
      if (!k) continue;
      if (seen.has(k)) parent.set(find(p.id), find(seen.get(k)!));
      else seen.set(k, p.id);
    }
  };
  link((p) => normalizeName(p.name));
  link((p) => normalizeEmail(p.email));
  const groups = new Map<number, Person[]>();
  for (const p of all) groups.set(find(p.id), [...(groups.get(find(p.id)) ?? []), p]);
  return [...groups.values()].filter((g) => g.length > 1);
}

/** An existing person to reuse instead of creating a duplicate: same email, else same name with no conflicting email. */
export async function findExistingPerson(orgId: string, name: string, email: string | null): Promise<Person | null> {
  const all = await db.select().from(people).where(eq(people.orgId, orgId));
  const e = normalizeEmail(email);
  if (e) {
    const byEmail = all.find((p) => normalizeEmail(p.email) === e);
    if (byEmail) return byEmail;
  }
  const n = normalizeName(name);
  return all.find((p) => normalizeName(p.name) === n && (!e || !normalizeEmail(p.email))) ?? null;
}
