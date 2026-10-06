import "server-only";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { decryptSecret, encryptSecret } from "./secrets";

/**
 * Bandcamp's official API (https://bandcamp.com/developer). Each account (label or band) has its own
 * API access, entered on its settings page and stored encrypted; it never leaves the server.
 *
 * Bandcamp allows one active sign-in per API client. So the sign-in (access token + refresh token)
 * is kept in the database, shared by every server process and restart, and renewed with the
 * refresh token when it expires. A brand-new sign-in is only requested when there's nothing to renew.
 */

export type BandcampCredentials = { clientId: string; clientSecret: string };

/** This account's Bandcamp API access, or null if it hasn't been set up. */
export async function bandcampCredentials(orgId: string): Promise<BandcampCredentials | null> {
  const [s] = await db.select().from(schema.accountSettings).where(eq(schema.accountSettings.orgId, orgId));
  if (!s?.bandcampClientId || !s.bandcampClientSecret) return null;
  return { clientId: s.bandcampClientId, clientSecret: decryptSecret(s.bandcampClientSecret) };
}

/** Imports made by syncing with the API are named with this. */
export const API_SYNC_PREFIX = "Bandcamp API sync";

type Token = { accessToken: string; expiresAt: number };
// A per-process copy of each account's token ("org:<id>"), so most calls don't touch the database.
// (Older code kept it here by client ID; that's picked up once and saved.)
const cache = globalThis as unknown as { bandcampTokens?: Map<string, Token> };
const tokens = (cache.bandcampTokens ??= new Map());
const cacheKey = (orgId: string) => `org:${orgId}`;

const stillGood = (expiresAt: number) => expiresAt > Date.now() + 60_000;

type GrantReply = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };

async function requestGrant(params: Record<string, string>): Promise<GrantReply & { status: number }> {
  const res = await fetch("https://bandcamp.com/oauth_token", {
    method: "POST",
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20000),
  });
  const body = (await res.json().catch(() => ({}))) as GrantReply;
  return { ...body, status: res.status };
}

/**
 * Bandcamp's refusal, in plain words. The common one: the API client already has an active sign-in
 * somewhere else (another copy of this app), and Bandcamp only allows one.
 */
export function describeGrantError(reply: { status: number; error?: string; error_description?: string }) {
  const text = `${reply.error ?? ""} ${reply.error_description ?? ""}`;
  if (/duplicate|already|another|in use|elsewhere|one location/i.test(text)) {
    return (
      "Bandcamp says this API client is already signed in somewhere else, probably another copy of this app. " +
      "Stop syncing from there; its sign-in runs out within about an hour, then try again here. " +
      `(Bandcamp said: ${reply.error_description ?? reply.error})`
    );
  }
  if (/invalid_client|unauthori[sz]ed/i.test(text)) return "Bandcamp didn't accept the client ID and secret. Check them under Settings.";
  return `Bandcamp didn't accept the API credentials${reply.error_description ? `: ${reply.error_description}` : ` (${reply.status})`}.`;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function saveTokens(tx: Tx, orgId: string, accessToken: string, expiresAt: number, refreshToken: string | null) {
  await tx
    .update(schema.accountSettings)
    .set({
      bandcampAccessToken: encryptSecret(accessToken),
      bandcampRefreshToken: refreshToken ? encryptSecret(refreshToken) : null,
      bandcampTokenExpiresAt: new Date(expiresAt).toISOString(),
    })
    .where(eq(schema.accountSettings.orgId, orgId));
  tokens.set(cacheKey(orgId), { accessToken, expiresAt });
  return accessToken;
}

const expiryOf = (reply: GrantReply) => Date.now() + (reply.expires_in ?? 3600) * 1000;

/** Forget the access token (e.g. Bandcamp rejected it), but keep the refresh token to renew with. */
async function dropAccessToken(orgId: string, clientId: string) {
  tokens.delete(cacheKey(orgId));
  tokens.delete(clientId);
  await db
    .update(schema.accountSettings)
    .set({ bandcampAccessToken: null, bandcampTokenExpiresAt: null })
    .where(eq(schema.accountSettings.orgId, orgId));
}

/** Forget the whole saved sign-in: when the client ID or secret changes. */
export async function forgetBandcampSignIn(orgId: string) {
  tokens.delete(cacheKey(orgId));
  await db
    .update(schema.accountSettings)
    .set({ bandcampAccessToken: null, bandcampRefreshToken: null, bandcampTokenExpiresAt: null, bandcampConnectedAs: null, bandcampCheckedAt: null })
    .where(eq(schema.accountSettings.orgId, orgId));
}

/**
 * A valid access token for the account: the saved one, else renewed with the refresh token, else a
 * new sign-in. This runs under a database lock, so two processes never renew at the same time (a
 * refresh token can only be used once).
 */
export async function accessToken(orgId: string, creds: BandcampCredentials): Promise<string> {
  const t = tokens.get(cacheKey(orgId));
  if (t && stillGood(t.expiresAt)) return t.accessToken;

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`bandcamp-sign-in:${orgId}`}))`);
    const [s] = await tx.select().from(schema.accountSettings).where(eq(schema.accountSettings.orgId, orgId));
    // Another process may have just renewed it.
    if (s?.bandcampAccessToken && s.bandcampTokenExpiresAt && stillGood(Date.parse(s.bandcampTokenExpiresAt))) {
      const saved = decryptSecret(s.bandcampAccessToken);
      tokens.set(cacheKey(orgId), { accessToken: saved, expiresAt: Date.parse(s.bandcampTokenExpiresAt) });
      return saved;
    }
    // A sign-in this process already had from before sign-ins were saved: keep using it.
    const legacy = tokens.get(creds.clientId);
    if (legacy && stillGood(legacy.expiresAt)) {
      tokens.delete(creds.clientId);
      return saveTokens(tx, orgId, legacy.accessToken, legacy.expiresAt, null);
    }
    const refresh = s?.bandcampRefreshToken ? decryptSecret(s.bandcampRefreshToken) : null;
    if (refresh) {
      const renewed = await requestGrant({
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      });
      if (renewed.access_token) return saveTokens(tx, orgId, renewed.access_token, expiryOf(renewed), renewed.refresh_token ?? refresh);
      // The refresh token is no good any more: fall back to a new sign-in.
    }
    const fresh = await requestGrant({ grant_type: "client_credentials", client_id: creds.clientId, client_secret: creds.clientSecret });
    if (!fresh.access_token) throw new Error(describeGrantError(fresh));
    return saveTokens(tx, orgId, fresh.access_token, expiryOf(fresh), fresh.refresh_token ?? null);
  });
}

async function call<T>(orgId: string, creds: BandcampCredentials, path: string, payload: object = {}, retried = false): Promise<T> {
  const res = await fetch(`https://bandcamp.com/api/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken(orgId, creds)}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });
  // Bandcamp no longer accepts this token: renew it once and try again.
  if (res.status === 401 && !retried) {
    await dropAccessToken(orgId, creds.clientId);
    return call(orgId, creds, path, payload, true);
  }
  const body = (await res.json().catch(() => null)) as (T & { error?: boolean; error_message?: string; message?: string }) | null;
  if (!res.ok || !body || body.error) {
    throw new Error(`Bandcamp API error on ${path}: ${body?.error_message ?? body?.message ?? res.status}`);
  }
  return body;
}

export type BandcampAccountBand = {
  band_id: number;
  name: string;
  subdomain: string;
  member_bands?: { band_id: number; name: string; subdomain: string }[];
};

/** The Bandcamp accounts this API access reaches. Also noted in settings, for the settings page. */
export async function myBands(orgId: string, creds: BandcampCredentials) {
  const bands = (await call<{ bands: BandcampAccountBand[] }>(orgId, creds, "account/1/my_bands")).bands;
  const summary = bands.map((b) => (b.member_bands?.length ? `${b.name} (with ${b.member_bands.length} artists)` : b.name)).join(", ");
  await db
    .update(schema.accountSettings)
    .set({ bandcampConnectedAs: summary || "no Bandcamp accounts", bandcampCheckedAt: new Date().toISOString() })
    .where(eq(schema.accountSettings.orgId, orgId));
  return bands;
}

/** "YYYY-MM-DD HH:MM:SS" in UTC, the format the sales API takes. */
function apiTime(d: Date) {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * The raw sales report (every sale, refund and payout row) for each account the credentials manage.
 * For a label that includes all its artists. Rows are the API's own objects, one per item sold.
 */
export async function salesReport(orgId: string, creds: BandcampCredentials, from: Date, to: Date) {
  const accounts = await myBands(orgId, creds);
  const rows = new Map<string, Record<string, unknown>>();
  for (const account of accounts) {
    const { report } = await call<{ report: Record<string, unknown>[] }>(orgId, creds, "sales/4/sales_report", {
      band_id: account.band_id,
      start_time: apiTime(from),
      end_time: apiTime(to),
      format: "json",
    });
    for (const r of report ?? []) rows.set(String(r.bandcamp_transaction_item_id ?? rows.size), r);
  }
  return { accounts, rows: [...rows.values()] };
}

/** One item of a merch order, as the Merch Orders API returns it (get_orders v4). */
export type MerchOrderItem = {
  sale_item_id: number;
  payment_id: number;
  order_date: string;
  item_name?: string;
  item_url?: string;
  artist?: string;
  option?: string | null;
  sku?: string | null;
  quantity?: number;
  sub_total?: number;
  shipping?: number;
  tax?: number;
  order_total?: number;
  currency?: string;
  buyer_name?: string;
  buyer_email?: string;
  buyer_phone?: string;
  buyer_note?: string | null;
  ship_notes?: string | null;
  ship_to_name?: string;
  ship_to_street?: string;
  ship_to_street_2?: string;
  ship_to_city?: string;
  ship_to_state?: string;
  ship_to_zip?: string;
  ship_to_country?: string;
  ship_to_country_code?: string;
  ship_to_phone?: string;
  begins_shipping_on?: string | null;
  ship_date?: string | null;
  payment_state?: string;
};

/**
 * Every merch order not marked shipped yet, for each account the credentials manage (for a label,
 * all its artists). Buyers' details come straight from Bandcamp and aren't stored.
 */
export async function openMerchOrders(orgId: string, creds: BandcampCredentials): Promise<MerchOrderItem[]> {
  const accounts = await myBands(orgId, creds);
  const items = new Map<number, MerchOrderItem>();
  for (const account of accounts) {
    const { items: found } = await call<{ items: MerchOrderItem[] }>(orgId, creds, "merchorders/4/get_orders", {
      band_id: account.band_id,
      unshipped_only: true,
      start_time: "2000-01-01",
      format: "json",
    });
    for (const it of found ?? []) items.set(it.sale_item_id, it);
  }
  return [...items.values()];
}

/**
 * Mark whole orders (by payment id) shipped on Bandcamp, with a carrier and tracking number shown to
 * the buyer, and optionally email them. All or nothing.
 */
export async function markMerchShipped(
  orgId: string,
  creds: BandcampCredentials,
  orders: { paymentId: number; carrier?: string; trackingCode?: string; notify: boolean; message?: string }[],
) {
  await call(orgId, creds, "merchorders/2/update_shipped", {
    items: orders.map((o) => ({
      id: o.paymentId,
      id_type: "p",
      shipped: true,
      notification: o.notify,
      ...(o.notify && o.message ? { notification_message: o.message } : {}),
      ...(o.carrier ? { carrier: o.carrier } : {}),
      ...(o.trackingCode ? { tracking_code: o.trackingCode } : {}),
    })),
  });
}
