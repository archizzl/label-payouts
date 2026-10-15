import { describe, expect, it, vi } from "vitest";

// Pretend to be on Cloudflare, with an in-memory receipts bucket.
const objects = vi.hoisted(() => new Map<string, { bytes: ArrayBuffer; type?: string }>());
// How much the account's receipts already take up.
const used = vi.hoisted(() => ({ bytes: 0 }));
vi.mock("@/db", async () => ({
  onCloudflare: true,
  schema: await import("@/db/schema"),
  db: { select: () => ({ from: () => ({ where: async () => [{ used: String(used.bytes) }] }) }) },
}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: {
      RECEIPTS: {
        put: async (k: string, bytes: ArrayBuffer, o?: { httpMetadata?: { contentType?: string } }) => void objects.set(k, { bytes, type: o?.httpMetadata?.contentType }),
        get: async (k: string) => (objects.has(k) ? { body: new Response(objects.get(k)!.bytes).body! } : null),
        delete: async (keys: string | string[]) => [keys].flat().forEach((k) => objects.delete(k)),
      },
    },
  }),
}));

const store = await import("../receipt-store");
const upload = (name: string, text: string) => {
  const file = new File([text], name, { type: "image/png" });
  return { file, filename: name, contentType: "image/png", size: file.size };
};

describe("receipt files on the live site", () => {
  it("go to the bucket (not the database), come back intact, and are removed with the receipt", async () => {
    const stored = await store.storeReceiptFiles("org1", [upload("a.png", "first"), upload("b.png", "second")]);
    expect(stored.every((f) => f.data === null && f.storageKey?.startsWith("receipts/org1/"))).toBe(true);
    expect(objects.size).toBe(2);
    expect(objects.get(stored[0].storageKey!)?.type).toBe("image/png");
    expect(await new Response(await store.readStoredFile(stored[1])).text()).toBe("second");
    await store.discardStoredFiles(stored);
    expect(objects.size).toBe(0);
    expect(await store.readStoredFile(stored[0])).toBeNull();
  });

  it("refuses files that would take the account past its receipt space, and keeps nothing", async () => {
    used.bytes = 20 * 1024 * 1024 - 3;
    await expect(store.storeReceiptFiles("org1", [upload("c.png", "four")])).rejects.toThrow(/Receipt storage is full: 20 MB of 20 MB used/);
    expect(objects.size).toBe(0);
    used.bytes = 0;
  });

  it("still serves files kept in the database", async () => {
    const body = await store.readStoredFile({ storageKey: null, data: new TextEncoder().encode("old") });
    expect(await new Response(body).text()).toBe("old");
  });
});
