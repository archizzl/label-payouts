import { syncStatus, UP_TO_DATE } from "@/server/auto-sync";
import { catalogSyncProgress, catalogSyncRequestedAt } from "@/server/catalog-requests";
import { accountContext, getContext } from "@/server/context";

/**
 * The signed-in account's Bandcamp sync, for an open page to notice one running or finished
 * (src/components/sync-indicator.tsx): whether it's running, when the last one finished, and
 * whether that brought anything in; and the catalog sync on the Mac: whether one is waiting or
 * running, and how far it's got.
 */
export async function GET() {
  // (A band account the label made syncs its own books: the account itself. Its catalog is the
  // label's, read for its band.)
  const [{ org }, { orgId: catalogOrgId }] = await Promise.all([accountContext(), getContext()]);
  const [s, requestedAt, progress] = await Promise.all([syncStatus(org.id), catalogSyncRequestedAt(catalogOrgId), catalogSyncProgress(catalogOrgId)]);
  return Response.json(
    {
      running: !!s?.running,
      finishedAt: s?.finishedAt ?? null,
      news: !!s?.summary && s.summary !== UP_TO_DATE,
      catalog: { busy: !!requestedAt || !!progress, done: progress?.done ?? null, total: progress?.total ?? null },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
