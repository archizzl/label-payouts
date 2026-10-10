/*
 * Inventory rules, kept free of the database so they can be tested on their own.
 */

export const MOVE_REASONS = [
  { key: "received", label: "Received", sign: 1 },
  { key: "sold", label: "Sold (shows, in person)", sign: -1 },
  { key: "used", label: "Used up", sign: -1 },
  { key: "given", label: "Given away", sign: -1 },
  { key: "damaged", label: "Damaged or lost", sign: -1 },
  { key: "recount", label: "Recount (set the count)", sign: 0 },
  { key: "other", label: "Other", sign: 0 },
] as const;

export type MoveReason = (typeof MOVE_REASONS)[number]["key"];

export const isMoveReason = (s: string): s is MoveReason => MOVE_REASONS.some((r) => r.key === s);

/**
 * What a move does to the count. Received adds; sold, used, given and damaged take away (whatever
 * sign was typed); a recount sets the count; other applies the amount as typed (+ or −). The count
 * never goes below zero.
 */
export function applyMove(onHand: number, reason: MoveReason, amount: number): { delta: number; onHandAfter: number } {
  const n = Math.trunc(amount);
  const sign = MOVE_REASONS.find((r) => r.key === reason)!.sign;
  const target = reason === "recount" ? Math.max(0, n) : Math.max(0, onHand + (sign === 0 ? n : sign * Math.abs(n)));
  return { delta: target - onHand, onHandAfter: target };
}

export const isLow = (item: { onHand: number; lowAt: number | null }) => item.lowAt !== null && item.onHand <= item.lowAt;

type Package = { bandcampId: number; title: string; sku: string | null; options?: { title: string; sku: string | null }[] };
type CatalogRelease = { id: number; title: string; kind: "album" | "track" | "merch"; bandId: number; packages: Package[] };
export type Candidate = { name: string; bandId: number; releaseId: number; packageId: number | null; option: string | null; sku: string | null };

/**
 * Every format and merch item in the catalog (one per size or colour) that isn't tracked yet, to
 * add in one go. Matched on the catalog item, package and option, so running it again adds only
 * what's new.
 */
export function catalogCandidates(
  releases: CatalogRelease[],
  tracked: { releaseId: number | null; packageId: number | null; option: string | null }[],
): Candidate[] {
  const key = (releaseId: number | null, packageId: number | null, option: string | null) => `${releaseId}|${packageId ?? ""}|${(option ?? "").toLowerCase()}`;
  const have = new Set(tracked.map((t) => key(t.releaseId, t.packageId, t.option)));
  const out: Candidate[] = [];
  for (const r of releases) {
    for (const p of r.packages) {
      const name = r.kind === "merch" || p.title.toLowerCase().includes(r.title.toLowerCase()) ? p.title : `${r.title} — ${p.title}`;
      const variants = p.options?.length ? p.options.map((o) => ({ option: o.title, sku: o.sku ?? p.sku })) : [{ option: null, sku: p.sku }];
      for (const v of variants) {
        if (have.has(key(r.id, p.bandcampId, v.option))) continue;
        have.add(key(r.id, p.bandcampId, v.option));
        out.push({ name, bandId: r.bandId, releaseId: r.id, packageId: p.bandcampId, option: v.option, sku: v.sku });
      }
    }
  }
  return out;
}
