import { beforeEach, describe, expect, it, vi } from "vitest";

// Pretend to be on Cloudflare, with an in-memory KV.
const store = vi.hoisted(() => new Map<string, string>());
vi.mock("@/db", () => ({ onCloudflare: true }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: {
      CATALOG_KV: {
        get: async (k: string) => store.get(k) ?? null,
        put: async (k: string, v: string) => void store.set(k, v),
        delete: async (k: string) => void store.delete(k),
        list: async ({ prefix }: { prefix: string }) => ({ keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
      },
    },
  }),
}));

const { requestCatalogSync, catalogSyncRequestedAt, catalogSyncProgress, pendingCatalogSyncs } = await import("../catalog-requests");
const route = await import("../../app/api/catalog-sync/route");

process.env.CATALOG_SYNC_SECRET = "s".repeat(64);
const auth = { authorization: `Bearer ${"s".repeat(64)}` };

beforeEach(() => store.clear());

describe("Sync now for the Mac's catalog sync", () => {
  it("is listed for the Mac, and cleared once it's done", async () => {
    await requestCatalogSync("org1");
    expect(await catalogSyncRequestedAt("org1")).toBeTruthy();
    const list = await (await route.GET(new Request("https://x/api/catalog-sync", { headers: auth }))).json();
    expect(list.requests.map((r: { orgId: string }) => r.orgId)).toEqual(["org1"]);
    await route.POST(new Request("https://x/api/catalog-sync", { method: "POST", headers: auth, body: JSON.stringify({ orgId: "org1", before: new Date(Date.now() + 1000).toISOString() }) }));
    expect(await catalogSyncRequestedAt("org1")).toBeNull();
  });

  it("keeps a request that came in after the sync started", async () => {
    await requestCatalogSync("org1");
    await route.POST(new Request("https://x/api/catalog-sync", { method: "POST", headers: auth, body: JSON.stringify({ orgId: "org1", before: "2000-01-01T00:00:00.000Z" }) }));
    expect(await catalogSyncRequestedAt("org1")).toBeTruthy();
  });

  it("is a 404 without the secret", async () => {
    expect((await route.GET(new Request("https://x/api/catalog-sync"))).status).toBe(404);
    expect((await route.GET(new Request("https://x/api/catalog-sync", { headers: { authorization: "Bearer nope" } }))).status).toBe(404);
  });

  it("can be for some bands only, adding up until it runs, and a whole one wins", async () => {
    await requestCatalogSync("label", [3]);
    await requestCatalogSync("label", [5]);
    expect((await pendingCatalogSyncs()).find((r) => r.orgId === "label")?.bandIds?.sort()).toEqual([3, 5]);
    await requestCatalogSync("label");
    await requestCatalogSync("label", [7]);
    expect((await pendingCatalogSyncs()).find((r) => r.orgId === "label")?.bandIds).toBeNull();
  });

  it("reads a request made before requests had bands as the whole account", async () => {
    store.set("request:old", "2026-10-01T00:00:00.000Z");
    expect(await pendingCatalogSyncs()).toEqual([{ orgId: "old", at: "2026-10-01T00:00:00.000Z", bandIds: null }]);
  });

  it("takes the Mac's progress, and drops it once the sync is done", async () => {
    await requestCatalogSync("org1");
    const post = (body: unknown) => route.POST(new Request("https://x/api/catalog-sync", { method: "POST", headers: auth, body: JSON.stringify(body) }));
    expect((await post({ orgId: "org1", progress: { done: 3, total: 40 } })).status).toBe(200);
    expect(await catalogSyncProgress("org1")).toMatchObject({ done: 3, total: 40 });
    await post({ orgId: "org1", before: new Date(Date.now() + 1000).toISOString() });
    expect(await catalogSyncProgress("org1")).toBeNull();
    expect(await catalogSyncRequestedAt("org1")).toBeNull();
  });
});
