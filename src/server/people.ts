import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";

const { people, bandMemberships, splitShares, deductions, payouts, outsideArtists } = schema;

type Person = typeof people.$inferSelect;

export const normalizeEmail = (e: string | null | undefined) => (e ?? "").trim().toLowerCase();
export const normalizeName = (n: string) => n.trim().toLowerCase().replace(/\s+/g, " ").replace(/[’`]/g, "'");

/**
 * Merge person `fromId` into `intoId`: everything that pointed at `from` now points at `into`,
 * and `from` is deleted. Where both had something (the same band, the same split, the same payout
 * period), they're combined rather than duplicated. Missing contact details are copied over.
 */
export function mergePeople(intoId: number, fromId: number) {
  if (intoId === fromId) return;
  db.transaction((tx) => {
    const into = tx.select().from(people).where(eq(people.id, intoId)).get();
    const from = tx.select().from(people).where(eq(people.id, fromId)).get();
    if (!into || !from) throw new Error("Person not found");

    // Contact details: keep what `into` has, fill gaps from `from`.
    tx.update(people)
      .set({
        email: into.email || from.email,
        paypalMe: into.paypalMe || from.paypalMe,
        venmo: into.venmo || from.venmo,
        cashtag: into.cashtag || from.cashtag,
        notes: [into.notes, from.notes].filter(Boolean).join("\n") || null,
      })
      .where(eq(people.id, intoId))
      .run();

    // Band memberships: one per band; merge roles, and stay current if either was.
    const intoBands = new Map(tx.select().from(bandMemberships).where(eq(bandMemberships.personId, intoId)).all().map((m) => [m.bandId, m]));
    for (const m of tx.select().from(bandMemberships).where(eq(bandMemberships.personId, fromId)).all()) {
      const existing = intoBands.get(m.bandId);
      if (existing) {
        tx.update(bandMemberships)
          .set({ roles: [...new Set([...existing.roles, ...m.roles])], active: existing.active || m.active })
          .where(eq(bandMemberships.id, existing.id))
          .run();
        tx.delete(bandMemberships).where(eq(bandMemberships.id, m.id)).run();
      } else {
        tx.update(bandMemberships).set({ personId: intoId }).where(eq(bandMemberships.id, m.id)).run();
      }
    }

    // Split shares: if both were in the same split, add their shares together.
    const intoShares = new Map(tx.select().from(splitShares).where(eq(splitShares.personId, intoId)).all().map((s) => [s.ruleId, s]));
    for (const s of tx.select().from(splitShares).where(eq(splitShares.personId, fromId)).all()) {
      const existing = intoShares.get(s.ruleId);
      if (existing) {
        tx.update(splitShares).set({ bps: existing.bps + s.bps }).where(eq(splitShares.id, existing.id)).run();
        tx.delete(splitShares).where(eq(splitShares.id, s.id)).run();
      } else {
        tx.update(splitShares).set({ personId: intoId }).where(eq(splitShares.id, s.id)).run();
      }
    }

    // Costs paid to them, and outside artists they're the contact for.
    tx.update(deductions).set({ personId: intoId }).where(eq(deductions.personId, fromId)).run();
    tx.update(outsideArtists).set({ contactPersonId: intoId }).where(eq(outsideArtists.contactPersonId, fromId)).run();

    // Payouts: one line per period and currency. Combine amounts and per-band breakdowns; a
    // combined line is only settled if both were.
    const intoPayouts = tx.select().from(payouts).where(eq(payouts.personId, intoId)).all();
    for (const p of tx.select().from(payouts).where(eq(payouts.personId, fromId)).all()) {
      const existing = intoPayouts.find((x) => x.periodId === p.periodId && x.currency === p.currency);
      if (!existing) {
        tx.update(payouts).set({ personId: intoId }).where(eq(payouts.id, p.id)).run();
        continue;
      }
      const byBand = { ...existing.byBand };
      for (const [band, cents] of Object.entries(p.byBand)) byBand[band] = (byBand[band] ?? 0) + cents;
      // Settled (paid, or kept in the label account) only if both were.
      const bothSettled = existing.status !== "pending" && p.status !== "pending";
      tx.update(payouts)
        .set({
          amountCents: existing.amountCents + p.amountCents,
          byBand,
          status: bothSettled ? existing.status : "pending",
          paidAt: bothSettled ? existing.paidAt : null,
          reference: [existing.reference, p.reference].filter(Boolean).join(", ") || null,
        })
        .where(eq(payouts.id, existing.id))
        .run();
      tx.delete(payouts).where(eq(payouts.id, p.id)).run();
    }

    if (from.holdsLabelAccount) tx.update(people).set({ holdsLabelAccount: true }).where(eq(people.id, intoId)).run();
    tx.delete(people).where(eq(people.id, fromId)).run();
  });
}

/** Which of two duplicate records to keep: the one with more history, then the older one. */
function keeper(a: Person, b: Person) {
  const weight = (p: Person) =>
    db.select().from(payouts).where(eq(payouts.personId, p.id)).all().length * 100 +
    db.select().from(splitShares).where(eq(splitShares.personId, p.id)).all().length * 10 +
    db.select().from(bandMemberships).where(eq(bandMemberships.personId, p.id)).all().length;
  const wa = weight(a);
  const wb = weight(b);
  return wa !== wb ? (wa > wb ? [a, b] : [b, a]) : a.id < b.id ? [a, b] : [b, a];
}

/**
 * People sharing an email address are the same person (they'd be paid to the same PayPal
 * account), so they're merged automatically. Returns the names that were merged.
 */
export function autoMergeByEmail(): string[] {
  const merged: string[] = [];
  let again = true;
  while (again) {
    again = false;
    const all = db.select().from(people).all();
    const byEmail = new Map<string, Person>();
    for (const p of all) {
      const e = normalizeEmail(p.email);
      if (!e) continue;
      const other = byEmail.get(e);
      if (other) {
        const [keep, drop] = keeper(other, p);
        mergePeople(keep.id, drop.id);
        merged.push(keep.name);
        again = true;
        break;
      }
      byEmail.set(e, p);
    }
  }
  return merged;
}

/** People who share a name or an email: probably (or, for email, certainly) the same person. */
export function possibleDuplicates(): Person[][] {
  const all = db.select().from(people).all();
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
export function findExistingPerson(name: string, email: string | null): Person | null {
  const all = db.select().from(people).all();
  const e = normalizeEmail(email);
  if (e) {
    const byEmail = all.find((p) => normalizeEmail(p.email) === e);
    if (byEmail) return byEmail;
  }
  const n = normalizeName(name);
  return all.find((p) => normalizeName(p.name) === n && (!e || !normalizeEmail(p.email))) ?? null;
}
