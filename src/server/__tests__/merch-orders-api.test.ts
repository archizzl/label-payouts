import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { newAccount, testDb } from "../../../test/helpers/db";

process.env.APP_ENCRYPTION_KEY ??= "test-key";

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let api: typeof import("../bandcamp-api");
let secrets: typeof import("../secrets");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  api = await import("../bandcamp-api");
  secrets = await import("../secrets");
});
afterEach(() => vi.unstubAllGlobals());

const creds = { clientId: "2653", clientSecret: "s3cret" };

/** Bandcamp, simulated: signs in, lists one label account, and answers merch calls. Records each call. */
function fakeBandcamp(orders: object[]) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: URLSearchParams | string }) => {
      const path = url.replace("https://bandcamp.com/", "");
      if (path.startsWith("oauth_token")) return new Response(JSON.stringify({ access_token: "A", refresh_token: "R", expires_in: 3600 }));
      const body = JSON.parse(String(init.body));
      calls.push({ path, body });
      if (path === "api/account/1/my_bands") return new Response(JSON.stringify({ bands: [{ band_id: 42, name: "Label", subdomain: "label" }] }));
      if (path === "api/merchorders/4/get_orders") return new Response(JSON.stringify({ success: true, items: orders }));
      if (path === "api/merchorders/2/update_shipped") return new Response(JSON.stringify({ success: true }));
      return new Response(JSON.stringify({ error: true, error_message: "unexpected" }), { status: 400 });
    }),
  );
  return calls;
}

async function account() {
  const orgId = await newAccount();
  await db.insert(schema.accountSettings).values({ orgId, bandcampClientId: creds.clientId, bandcampClientSecret: secrets.encryptSecret(creds.clientSecret) });
  return orgId;
}

describe("Bandcamp merch orders", () => {
  it("asks for unshipped orders for each account", async () => {
    const orgId = await account();
    const calls = fakeBandcamp([{ sale_item_id: 1, payment_id: 9, order_date: "02 Oct 2026 18:00:00 GMT" }]);
    const items = await api.openMerchOrders(orgId, creds);
    expect(items).toHaveLength(1);
    expect(calls.find((c) => c.path === "api/merchorders/4/get_orders")?.body).toMatchObject({ band_id: 42, unshipped_only: true });
  });

  it("marks an order shipped with carrier and tracking, emailing the buyer only when asked", async () => {
    const orgId = await account();
    const calls = fakeBandcamp([]);
    await api.markMerchShipped(orgId, creds, [{ paymentId: 9, carrier: "USPS", trackingCode: "9400", notify: true, message: "Thanks!" }]);
    await api.markMerchShipped(orgId, creds, [{ paymentId: 10, notify: false, message: "ignored" }]);
    const sent = calls.filter((c) => c.path === "api/merchorders/2/update_shipped").map((c) => c.body.items);
    expect(sent).toEqual([
      [{ id: 9, id_type: "p", shipped: true, notification: true, notification_message: "Thanks!", carrier: "USPS", tracking_code: "9400" }],
      [{ id: 10, id_type: "p", shipped: true, notification: false }],
    ]);
  });
});
