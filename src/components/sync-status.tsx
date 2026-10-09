import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/client";
import { syncWithBandcamp } from "@/server/actions";
import { onCloudflare } from "@/db";
import { CATALOG_SYNC_EVERY_MINUTES, syncStatus } from "@/server/auto-sync";
import { bandcampApiOff } from "@/server/bandcamp-api";
import { catalogSyncRequestedAt } from "@/server/catalog-requests";

/** "5 minutes ago", "2 hours ago", "3 days ago". */
export function ago(iso: string) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  // Whole hours and days passed (1 hour 40 minutes is "1 hour ago", not "2 hours ago").
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Where the account stands with Bandcamp: what syncs when, when it last did and what that brought
 * in (or what went wrong), with a button to sync right now. The hourly sync also runs whenever
 * someone opens the app; on the live site, a Mac syncs the catalog every 10 minutes.
 */
export async function SyncStatus({ orgId }: { orgId: string }) {
  const s = await syncStatus(orgId);
  if (!s?.configured) {
    return (
      <p className="text-sm text-muted">
        Add your Bandcamp address (and API access, for sales) under <Link href="/account">Settings</Link> to keep artists, releases
        and sales in sync automatically.
      </p>
    );
  }
  const requestedAt = await catalogSyncRequestedAt(orgId);
  // What the hourly sync covers here. On the live site Bandcamp's pages can't be read, so artists'
  // details and releases come from the catalog sync on a Mac instead (the second line).
  const apiOn = !!s.hasApi && !bandcampApiOff();
  const hourly = onCloudflare
    ? apiOn
      ? "Sales, merch and new artists"
      : "Bandcamp"
    : apiOn
      ? "Sales, merch, artists and releases"
      : "Artists and releases";
  const sentence = (summary: string | null) => (summary ? summary.charAt(0).toLowerCase() + summary.slice(1) : "");
  return (
    <ActionForm action={syncWithBandcamp} className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2 text-sm">
      <div className="space-y-1 text-muted">
        <p>
          {s.running ? (
            `${hourly}: syncing now…`
          ) : s.finishedAt ? (
            <>
              {hourly}: synced {ago(s.finishedAt)} (hourly), {sentence(s.summary)}
              {s.error && <span className="text-warn"> {s.error}</span>}
            </>
          ) : (
            `${hourly}: not synced yet.`
          )}
        </p>
        {(s.catalogSyncedAt || requestedAt) && (
          <p>
            Releases, track lists, artwork and artist photos:{" "}
            {requestedAt
              ? "update on its way, usually within a minute."
              : `synced ${ago(s.catalogSyncedAt!)} (every ${CATALOG_SYNC_EVERY_MINUTES} minutes).`}
          </p>
        )}
      </div>
      <SubmitButton size="sm" variant="secondary">
        Sync now
      </SubmitButton>
    </ActionForm>
  );
}

/** The sync status as a quiet footer at the bottom of a page. */
export function SyncFooter({ orgId }: { orgId: string }) {
  return (
    <div className="mt-10 border-t border-border pt-4">
      <SyncStatus orgId={orgId} />
    </div>
  );
}
