import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { onCloudflare } from "@/db";

/*
 * "Sync now" for the catalog sync that runs on a Mac (`npm run sync-catalog:schedule`), which the
 * live site can't run itself. A request is a key in Cloudflare KV (not the database, so the Mac's
 * once-a-minute check never wakes it): the Mac picks it up through /api/catalog-sync and clears it.
 * Off Cloudflare there's nothing to ask: the app's own sync reads the pages itself.
 */

/** The bits of Cloudflare's KV used here. */
type KV = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string }): Promise<{ keys: { name: string }[] }>;
};

const key = (orgId: string) => `request:${orgId}`;

function kv(): KV | null {
  if (!onCloudflare) return null;
  return (getCloudflareContext().env as unknown as { CATALOG_KV?: KV }).CATALOG_KV ?? null;
}

/** Ask the Mac to sync this account's catalog as soon as it can. */
export async function requestCatalogSync(orgId: string) {
  await kv()?.put(key(orgId), new Date().toISOString());
}

/** When this account asked for a catalog sync that hasn't happened yet, if it has. */
export async function catalogSyncRequestedAt(orgId: string): Promise<string | null> {
  return (await kv()?.get(key(orgId))) ?? null;
}

/** Every waiting request: which accounts, and when they asked. */
export async function pendingCatalogSyncs(): Promise<{ orgId: string; at: string }[]> {
  const store = kv();
  if (!store) return [];
  const { keys } = await store.list({ prefix: "request:" });
  const out: { orgId: string; at: string }[] = [];
  for (const k of keys) {
    const at = await store.get(k.name);
    if (at) out.push({ orgId: k.name.slice("request:".length), at });
  }
  return out;
}

/** Done: clear the request, unless a newer one came in while the sync was running. */
export async function clearCatalogSync(orgId: string, before: string) {
  const store = kv();
  const at = await store?.get(key(orgId));
  if (store && at && at <= before) await store.delete(key(orgId));
}
