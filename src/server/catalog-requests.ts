import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { onCloudflare } from "@/db";

/*
 * "Sync now" for the catalog sync that runs on a Mac (`npm run sync-catalog:schedule`), which the
 * live site can't run itself. A request is a key in Cloudflare KV (not the database, so the Mac's
 * once-a-minute check never wakes it): the Mac picks it up through /api/catalog-sync and clears it.
 * A request can be for some of the account's bands only (a band's own group asking for its part).
 * While it runs, the Mac reports how far it's got, for the page to show. The request also goes
 * straight to the Mac if it's connected (cloudflare/catalog-hub.ts), so it starts at once; the
 * Mac's once-a-minute check through KV catches any it missed.
 * Off Cloudflare there's nothing to ask: the app's own sync reads the pages itself.
 */

/** The bits of Cloudflare's KV used here. */
type KV = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string }): Promise<{ keys: { name: string }[] }>;
};

/** A waiting request: when it was made, and for which bands (null: all of them). */
export type CatalogRequest = { at: string; bandIds: number[] | null };
/** How far a running sync has got: pages read of those to read. */
export type CatalogProgress = { done: number; total: number; at: string };

const key = (orgId: string) => `request:${orgId}`;
const progressKey = (orgId: string) => `progress:${orgId}`;

/** The Durable Object the Mac keeps a WebSocket open to. */
type Hub = { idFromName(name: string): unknown; get(id: unknown): { fetch(url: string, init?: RequestInit): Promise<Response> } };

function hub(): Hub | null {
  if (!onCloudflare) return null;
  return (getCloudflareContext().env as unknown as { CATALOG_HUB?: Hub }).CATALOG_HUB ?? null;
}

function kv(): KV | null {
  if (!onCloudflare) return null;
  return (getCloudflareContext().env as unknown as { CATALOG_KV?: KV }).CATALOG_KV ?? null;
}

/** A stored request (older ones are just the time they were made). */
function parse(raw: string | null): CatalogRequest | null {
  if (!raw) return null;
  if (!raw.startsWith("{")) return { at: raw, bandIds: null };
  try {
    const r = JSON.parse(raw) as Partial<CatalogRequest>;
    return typeof r.at === "string" ? { at: r.at, bandIds: Array.isArray(r.bandIds) ? r.bandIds : null } : null;
  } catch {
    return null;
  }
}

/**
 * Ask the Mac to sync this account's catalog as soon as it can: all of it, or (`bandIds`) just
 * those bands' releases. Asking again adds to a request still waiting.
 */
export async function requestCatalogSync(orgId: string, bandIds: number[] | null = null) {
  const store = kv();
  if (!store) return;
  const before = parse(await store.get(key(orgId)));
  const bands = before && (before.bandIds === null || bandIds === null) ? null : [...new Set([...(before?.bandIds ?? []), ...(bandIds ?? [])])];
  const request: CatalogRequest = { at: new Date().toISOString(), bandIds: bandIds === null ? null : bands };
  await store.put(key(orgId), JSON.stringify(request));
  // Straight to the Mac, if it's connected.
  const macs = hub();
  if (macs) {
    try {
      await macs.get(macs.idFromName("mac")).fetch("https://hub/notify", { method: "POST", body: JSON.stringify({ type: "sync", orgId, ...request }) });
    } catch (e) {
      console.error("Couldn't reach the catalog hub:", e);
    }
  }
}

/** When this account asked for a catalog sync that hasn't happened yet, if it has. */
export async function catalogSyncRequestedAt(orgId: string): Promise<string | null> {
  return parse((await kv()?.get(key(orgId))) ?? null)?.at ?? null;
}

/** Every waiting request: which accounts, when they asked, and for which bands. */
export async function pendingCatalogSyncs(): Promise<({ orgId: string } & CatalogRequest)[]> {
  const store = kv();
  if (!store) return [];
  const { keys } = await store.list({ prefix: "request:" });
  const out: ({ orgId: string } & CatalogRequest)[] = [];
  for (const k of keys) {
    const r = parse(await store.get(k.name));
    if (r) out.push({ orgId: k.name.slice("request:".length), ...r });
  }
  return out;
}

/** Done: clear the request, unless a newer one came in while the sync was running. */
export async function clearCatalogSync(orgId: string, before: string) {
  const store = kv();
  if (!store) return;
  await store.delete(progressKey(orgId));
  const r = parse(await store.get(key(orgId)));
  if (r && r.at <= before) await store.delete(key(orgId));
}

/** The Mac's progress on this account's sync (gone once it's done; dropped after an hour regardless). */
export async function setCatalogProgress(orgId: string, progress: { done: number; total: number } | null) {
  const store = kv();
  if (!store) return;
  if (!progress) await store.delete(progressKey(orgId));
  else await store.put(progressKey(orgId), JSON.stringify({ ...progress, at: new Date().toISOString() }), { expirationTtl: 3600 });
}

/** How far this account's catalog sync has got, while one is running. */
export async function catalogSyncProgress(orgId: string): Promise<CatalogProgress | null> {
  const raw = await kv()?.get(progressKey(orgId));
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as CatalogProgress;
    // A sync that stopped reporting is over (it gives up after 15 minutes).
    return Date.parse(p.at) > Date.now() - 15 * 60 * 1000 ? p : null;
  } catch {
    return null;
  }
}
