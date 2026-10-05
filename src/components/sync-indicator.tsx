"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * While a background sync with Bandcamp is running: a small note in the header, and a quiet page
 * refresh every few seconds, so whatever the sync brings in shows up without reloading. Stops once
 * a refresh says it's done (or after a few minutes, whichever comes first).
 */
export function SyncIndicator({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > 5 * 60_000) clearInterval(timer);
      else router.refresh();
    }, 4000);
    return () => clearInterval(timer);
  }, [active, router]);
  if (!active) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted" role="status">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden />
      syncing with Bandcamp…
    </span>
  );
}
