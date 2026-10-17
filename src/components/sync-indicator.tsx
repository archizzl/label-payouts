"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/** How often an open page asks how the Bandcamp sync is doing: while one runs, and otherwise. */
const WHILE_SYNCING_MS = 4000;
const OTHERWISE_MS = 60_000;
/** A sync that was about to start, or is running, is watched closely for this long. */
const WATCH_MS = 5 * 60_000;

type SyncState = { running: boolean; finishedAt: string | null; news: boolean };

/**
 * Keeps an open page in step with the Bandcamp sync (the hourly one, one started on opening the app,
 * or Sync now in another tab): a small note in the header while it runs, and a quiet refresh when one
 * finishes having brought something in. It checks /api/sync-state every minute (every few seconds
 * while a sync is running or about to start), and only while the page is being looked at.
 */
export function SyncIndicator({ active, syncedAt }: { active: boolean; syncedAt: string | null }) {
  const router = useRouter();
  const [running, setRunning] = useState(active);
  // The last finished sync this page knows about, and until when to watch closely.
  const known = useRef(syncedAt);
  const watchUntil = useRef(0);

  // A refresh brings the latest finished sync with it.
  useEffect(() => {
    known.current = syncedAt;
  }, [syncedAt]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const check = async () => {
      clearTimeout(timer);
      if (document.visibilityState === "visible") {
        try {
          const res = await fetch("/api/sync-state", { cache: "no-store" });
          if (res.ok && res.headers.get("content-type")?.includes("json")) {
            const s = (await res.json()) as SyncState;
            if (s.running) watchUntil.current = Date.now() + WATCH_MS;
            if (s.finishedAt && s.finishedAt !== known.current) {
              known.current = s.finishedAt;
              watchUntil.current = 0;
              if (s.news) router.refresh();
            }
            setRunning(s.running);
          }
        } catch {
          // Offline for a moment: try again next time.
        }
      }
      if (!stopped) timer = setTimeout(check, Date.now() < watchUntil.current ? WHILE_SYNCING_MS : OTHERWISE_MS);
    };
    // A sync that was running (or about to start) when the page was drawn.
    if (active) watchUntil.current = Date.now() + WATCH_MS;
    const onShow = () => {
      if (document.visibilityState === "visible") void check();
    };
    timer = setTimeout(check, Date.now() < watchUntil.current ? WHILE_SYNCING_MS : OTHERWISE_MS);
    document.addEventListener("visibilitychange", onShow);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [active, router]);

  if (!running) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted" role="status">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden />
      syncing with Bandcamp…
    </span>
  );
}
