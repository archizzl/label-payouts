import { syncStatus, UP_TO_DATE } from "@/server/auto-sync";
import { accountContext } from "@/server/context";

/**
 * The signed-in account's Bandcamp sync, for an open page to notice one running or finished
 * (src/components/sync-indicator.tsx): whether it's running, when the last one finished, and
 * whether that brought anything in.
 */
export async function GET() {
  // (A band account the label made syncs its own books: the account itself.)
  const { org } = await accountContext();
  const s = await syncStatus(org.id);
  return Response.json(
    { running: !!s?.running, finishedAt: s?.finishedAt ?? null, news: !!s?.summary && s.summary !== UP_TO_DATE },
    { headers: { "cache-control": "no-store" } },
  );
}
