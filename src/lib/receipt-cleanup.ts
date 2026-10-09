/*
 * Clearing out receipt files once a receipt is settled: approved, and nothing left to pay back.
 * Plain logic (no database), so it can be tested on its own.
 */

type SettleInput = {
  status: "pending" | "approved" | "rejected";
  paidBy: "label" | "band_fund" | "person";
  recoup: boolean;
  reimbursedAt: string | null;
  amountCents: number;
};

/**
 * Settled: approved, and either paid back from sales in full, paid back to whoever fronted it, or
 * paid by the label or a band fund with nothing to pay back.
 */
export function isSettled(e: SettleInput, recoupedCents = 0): boolean {
  if (e.status !== "approved") return false;
  if (e.recoup) return recoupedCents >= e.amountCents;
  if (e.paidBy === "person") return !!e.reimbursedAt;
  return true;
}

/** Downloads are made in memory, so big clear-outs come in parts of at most this much. */
export const BATCH_BYTES = 40 * 1024 * 1024;

/** Group files into parts, in order, none over the limit (a single bigger file gets a part of its own). */
export function batchFiles<T extends { size: number }>(files: T[], maxBytes = BATCH_BYTES): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const f of files) {
    if (cur.length && bytes + f.size > maxBytes) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(f);
    bytes += f.size;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** "2026-03-04 Postage for 3 orders - IMG_1234.jpg", safe in a zip, and unique within it. */
export function archiveNames(files: { date: string; description: string; filename: string }[]): string[] {
  const seen = new Map<string, number>();
  return files.map((f) => {
    const clean = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim();
    const base = `${f.date} ${clean(f.description).slice(0, 60)} - ${clean(f.filename) || "file"}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    if (n === 1) return base;
    const dot = base.lastIndexOf(".");
    return dot > 0 ? `${base.slice(0, dot)} (${n})${base.slice(dot)}` : `${base} (${n})`;
  });
}
