/*
 * Which releases a catalog sync reads again from their Bandcamp pages: any whose cover on the label's
 * music page isn't the one we have (a new cover shows there straight away), and the longest-unread
 * of the rest once they're a week old (a few per sync, or all of them for the full catalog read).
 */

/** Bandcamp's id for an image, whatever size its address asks for: ".../img/a0123456789_16.jpg" → "a123456789". */
export function bandcampImageKey(url: string | null | undefined): string | null {
  const m = url?.match(/bcbits\.com\/img\/(a?)0*(\d+)_\d+\.jpg/);
  return m ? `${m[1]}${m[2]}` : null;
}

export type Listed = { releaseId: number | null; status: "new" | "imported"; artUrl: string | null };
export type Stored = { syncedAt: string | null; artUrl: string | null };

/** The ids of releases already here to read again, cover changes first. `limit`: how many of the merely old ones (none: all). */
export function releasesToRefresh(listed: Listed[], stored: Map<number, Stored>, staleBefore: string, limit?: number): number[] {
  const here = listed.filter((r): r is Listed & { releaseId: number } => r.status === "imported" && r.releaseId !== null && stored.has(r.releaseId));
  const changed = here.filter((r) => {
    const now = bandcampImageKey(r.artUrl);
    const had = bandcampImageKey(stored.get(r.releaseId)!.artUrl);
    // (Only when both are Bandcamp's: an uploaded photo, or none listed, isn't a change.)
    return !!now && !!had && now !== had;
  });
  const changedIds = new Set(changed.map((r) => r.releaseId));
  const old = here
    .filter((r) => !changedIds.has(r.releaseId) && (stored.get(r.releaseId)!.syncedAt ?? "") < staleBefore)
    .sort((a, b) => (stored.get(a.releaseId)!.syncedAt ?? "").localeCompare(stored.get(b.releaseId)!.syncedAt ?? ""))
    .slice(0, limit);
  return [...changedIds, ...old.map((r) => r.releaseId)];
}
