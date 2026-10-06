import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/client";
import { syncWithBandcamp } from "@/server/actions";
import { syncStatus } from "@/server/auto-sync";

/** "5 minutes ago", "2 hours ago", "3 days ago". */
export function ago(iso: string) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Where the account stands with Bandcamp: when it last synced and what that brought in (or what
 * went wrong), with a button to sync right now. Syncing also happens on its own, at most hourly,
 * whenever someone opens the app.
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
  return (
    <ActionForm action={syncWithBandcamp} className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      <span className="text-muted">
        {s.running ? (
          "Syncing with Bandcamp now…"
        ) : s.finishedAt ? (
          <>
            Synced with Bandcamp {ago(s.finishedAt)}: {s.summary}
            {s.error && <span className="text-warn"> {s.error}</span>}
          </>
        ) : (
          "Not synced with Bandcamp yet."
        )}{" "}
      </span>
      <SubmitButton size="sm" variant="secondary">
        Sync now
      </SubmitButton>
    </ActionForm>
  );
}
