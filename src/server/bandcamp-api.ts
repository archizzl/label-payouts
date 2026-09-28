import "server-only";

/**
 * Bandcamp's official API (https://bandcamp.com/developer). Credentials live in .env.local as
 * BANDCAMP_CLIENT_ID / BANDCAMP_CLIENT_SECRET and never leave the server.
 */

/** Imports made by syncing with the API are named with this. */
export const API_SYNC_PREFIX = "Bandcamp API sync";

type Token = { accessToken: string; expiresAt: number };
// Kept on globalThis so dev reloads don't ask Bandcamp for a new token every time.
const cache = globalThis as unknown as { bandcampToken?: Token };

export function bandcampApiConfigured() {
  return Boolean(process.env.BANDCAMP_CLIENT_ID && process.env.BANDCAMP_CLIENT_SECRET);
}

async function token(): Promise<string> {
  const t = cache.bandcampToken;
  if (t && t.expiresAt > Date.now() + 60_000) return t.accessToken;
  if (!bandcampApiConfigured()) throw new Error("Bandcamp API credentials aren't set (BANDCAMP_CLIENT_ID and BANDCAMP_CLIENT_SECRET in .env.local).");
  const res = await fetch("https://bandcamp.com/oauth_token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.BANDCAMP_CLIENT_ID!,
      client_secret: process.env.BANDCAMP_CLIENT_SECRET!,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`Bandcamp didn't accept the API credentials${body.error_description ? `: ${body.error_description}` : ` (${res.status})`}.`);
  }
  cache.bandcampToken = { accessToken: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return body.access_token;
}

async function call<T>(path: string, payload: object = {}): Promise<T> {
  const res = await fetch(`https://bandcamp.com/api/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });
  if (res.status === 401) cache.bandcampToken = undefined;
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

export async function myBands() {
  return (await call<{ bands: BandcampAccountBand[] }>("account/1/my_bands")).bands;
}

/** "YYYY-MM-DD HH:MM:SS" in UTC, the format the sales API takes. */
function apiTime(d: Date) {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * The raw sales report (every sale, refund and payout row) for each account the credentials manage.
 * For a label that includes all its artists. Rows are the API's own objects, one per item sold.
 */
export async function salesReport(from: Date, to: Date) {
  const accounts = await myBands();
  const rows = new Map<string, Record<string, unknown>>();
  for (const account of accounts) {
    const { report } = await call<{ report: Record<string, unknown>[] }>("sales/4/sales_report", {
      band_id: account.band_id,
      start_time: apiTime(from),
      end_time: apiTime(to),
      format: "json",
    });
    for (const r of report ?? []) rows.set(String(r.bandcamp_transaction_item_id ?? rows.size), r);
  }
  return { accounts, rows: [...rows.values()] };
}
