import "server-only";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { artistsFromApi, merchFromApi, releasesFromSales } from "./api-catalog";
import { type BandcampAccountBand, bandcampCredentials, myBands } from "./bandcamp-api";
import { reRouteAll } from "./data";
import { addArtists, importReleases, lookupLabelArtists, lookupLabelReleases, type ReleaseImportRow, runSalesSync } from "./sync";

/*
 * Keeping an account in step with Bandcamp: its artists (for a label), releases and merch (from its
 * public pages) and its sales (through the API). It runs in the background whenever someone opens
 * the app, at most once an hour, and straight away when an admin asks for it.
 */

const { accountSettings, releases } = schema;

/** How often opening the app syncs. */
export const AUTO_SYNC_EVERY_MS = 60 * 60 * 1000;
/** A sync that started this long ago and never finished is treated as dead. */
const STUCK_AFTER_MS = 15 * 60 * 1000;
/** Releases already here are refreshed from their page about this often, a few per sync. */
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_PER_SYNC = 10;

/** A sync's note when Bandcamp's public pages couldn't be read from here. */
export const BLOCKED_NOTE =
  "Bandcamp doesn't show its public pages to the live site, so artists, merch, formats and new releases come from the API; track lists, artwork and release dates come from running npm run sync-catalog on a Mac.";

class Blocked extends Error {}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Claim the account's next sync, so only one runs at a time (across server processes). Without
 * `force`, only if the last one started over an hour ago. Returns false if it shouldn't run now.
 */
export async function claimSync(orgId: string, force: boolean): Promise<boolean> {
  const now = Date.now();
  const due = or(isNull(accountSettings.syncStartedAt), lt(accountSettings.syncStartedAt, iso(now - AUTO_SYNC_EVERY_MS)));
  // Even when forced, don't start a second sync while one is (recently) running.
  const notRunning = or(
    isNull(accountSettings.syncStartedAt),
    sql`${accountSettings.syncFinishedAt} >= ${accountSettings.syncStartedAt}`,
    lt(accountSettings.syncStartedAt, iso(now - STUCK_AFTER_MS)),
  );
  const claimed = await db
    .update(accountSettings)
    .set({ syncStartedAt: iso(now) })
    .where(and(eq(accountSettings.orgId, orgId), force ? notRunning : and(due, notRunning)))
    .returning({ orgId: accountSettings.orgId });
  return claimed.length > 0;
}

export type SyncResult = { ran: boolean; summary: string; errors: string[] };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Bring in what's new on Bandcamp. With `force`, ignores the once-an-hour limit. With `refreshAll`,
 * re-reads every release's page that's due a refresh, not just a few (for `npm run sync-catalog`).
 */
export async function syncAccount(orgId: string, { force = false, refreshAll = false } = {}): Promise<SyncResult> {
  const [settings] = await db.select().from(accountSettings).where(eq(accountSettings.orgId, orgId));
  const creds = await bandcampCredentials(orgId);
  if (!settings || (!settings.bandcampUrl && !creds)) {
    return { ran: false, summary: "Nothing to sync: add your Bandcamp address or API access under Settings.", errors: [] };
  }
  if (!(await claimSync(orgId, force))) return { ran: false, summary: "Already synced recently.", errors: [] };

  const [org] = await db.select().from(schema.organization).where(eq(schema.organization.id, orgId));
  const found: string[] = [];
  const errors: string[] = [];
  /** Bandcamp showed us a bot check instead of its public pages (it does for cloud servers). */
  let blocked = false;
  const step = async (what: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (e) {
      if (e instanceof Blocked) blocked = true;
      else errors.push(`${what}: ${(e as Error).message}`);
    }
  };
  const lookedUp = <T extends object>(lookup: T | { error: string; blocked?: true }): T => {
    if ("error" in lookup) throw lookup.blocked ? new Blocked() : new Error(lookup.error);
    return lookup as T;
  };

  // Through the API: the label's artists, then merch and formats.
  let accounts: BandcampAccountBand[] = [];
  if (creds) {
    await step("Bandcamp accounts", async () => {
      accounts = await myBands(orgId, creds);
    });
    if (org?.kind === "label" && accounts.length) {
      await step("Artists", async () => {
        const { added, linked } = await artistsFromApi(orgId, accounts);
        if (added) found.push(plural(added, "new artist"));
        if (linked) found.push(`${plural(linked, "band")} linked to Bandcamp`);
      });
    }
  }

  if (settings.bandcampUrl) {
    const url = settings.bandcampUrl;
    // A label's artists. (A band account has no artists page.)
    if (org?.kind === "label") {
      await step("Artists", async () => {
        const lookup = lookedUp(await lookupLabelArtists(orgId, url));
        const rows = lookup.artists.filter((a) => a.status !== "linked");
        if (!rows.length) return;
        const { added, updated } = await addArtists(orgId, rows);
        if (added) found.push(plural(added, "new artist"));
        if (updated) found.push(`${plural(updated, "band")} linked to Bandcamp`);
      });
    }
    // Releases and merch: import new ones, and refresh a few older ones.
    await step("Releases", async () => {
      const lookup = lookedUp(await lookupLabelReleases(orgId, url));
      // A band account's releases are all its own band's.
      const bandRows = await db.select().from(schema.bands).where(eq(schema.bands.orgId, orgId));
      const onlyBand = org?.kind === "band" && bandRows.length === 1 ? bandRows[0] : null;
      const toRow = (r: (typeof lookup.releases)[number]): ReleaseImportRow => ({
        url: r.url,
        title: r.title,
        artist: r.artist,
        bandName: onlyBand?.name ?? r.bandName,
        bandId: onlyBand?.id ?? r.bandId,
        releaseId: r.releaseId,
      });
      const fresh = lookup.releases.filter((r) => r.status === "new");
      const staleBefore = iso(Date.now() - REFRESH_AFTER_MS);
      const syncedAt = new Map(
        (await db.select({ id: releases.id, syncedAt: releases.syncedAt }).from(releases).where(eq(releases.orgId, orgId))).map((r) => [
          r.id,
          r.syncedAt,
        ]),
      );
      const stale = lookup.releases
        .filter((r) => r.status === "imported" && r.releaseId && (syncedAt.get(r.releaseId) ?? "") < staleBefore)
        .sort((a, b) => (syncedAt.get(a.releaseId!) ?? "").localeCompare(syncedAt.get(b.releaseId!) ?? ""))
        .slice(0, refreshAll ? undefined : REFRESH_PER_SYNC);
      if (!fresh.length && !stale.length) return;
      const results = await importReleases(orgId, [...fresh, ...stale].map(toRow), lookup.labelHost, lookup.label);
      const created = results.filter((r) => r.ok && r.created);
      const merch = fresh.filter((r) => r.kind === "merch").length;
      if (created.length) {
        found.push(merch ? `${plural(created.length - merch, "new release")}, ${merch} merch` : plural(created.length, "new release"));
      }
      const failed = results.filter((r) => !r.ok);
      if (failed.length) errors.push(`Couldn't read ${plural(failed.length, "Bandcamp page")} (e.g. ${failed[0].title}).`);
      await reRouteAll(orgId);
    });
  }

  if (creds && accounts.length) {
    await step("Merch", async () => {
      const { formats, merch } = await merchFromApi(orgId, creds, accounts);
      if (merch) found.push(plural(merch, "merch item"));
      if (formats) found.push(plural(formats, "format"));
    });
  }

  // Sales last, so anything new in the catalog is there to match them to. Then albums that sold
  // but aren't in the catalog yet (when the public pages couldn't be read).
  if (creds) {
    await step("Sales", async () => {
      const { added } = await runSalesSync(orgId);
      if (added) found.push(plural(added, "new sale"));
    });
    await step("Releases from sales", async () => {
      const { added } = await releasesFromSales(orgId);
      if (added) found.push(plural(added, "new release"));
    });
  }

  let summary = found.length ? `Brought in ${found.join(", ")}.` : "Up to date.";
  if (blocked) summary += ` ${BLOCKED_NOTE}`;
  await db
    .update(accountSettings)
    .set({ syncFinishedAt: iso(Date.now()), syncSummary: summary, syncError: errors.length ? errors.join(" ") : null })
    .where(eq(accountSettings.orgId, orgId));
  return { ran: true, summary, errors };
}

/** The account's last sync, for showing on the page. */
export async function syncStatus(orgId: string) {
  const [s] = await db
    .select({
      startedAt: accountSettings.syncStartedAt,
      finishedAt: accountSettings.syncFinishedAt,
      summary: accountSettings.syncSummary,
      error: accountSettings.syncError,
      bandcampUrl: accountSettings.bandcampUrl,
      hasApi: accountSettings.bandcampClientId,
    })
    .from(accountSettings)
    .where(eq(accountSettings.orgId, orgId));
  if (!s) return null;
  const running = !!s.startedAt && (!s.finishedAt || s.finishedAt < s.startedAt) && Date.parse(s.startedAt) > Date.now() - STUCK_AFTER_MS;
  const configured = !!(s.bandcampUrl || s.hasApi);
  /** Opening the app now should start a sync. */
  const due = configured && !running && (!s.startedAt || Date.parse(s.startedAt) < Date.now() - AUTO_SYNC_EVERY_MS);
  return { ...s, running, configured, due };
}
