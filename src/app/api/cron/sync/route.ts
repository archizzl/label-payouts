import { timingSafeEqual } from "node:crypto";
import { isNotNull, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { syncAccount } from "@/server/auto-sync";

/**
 * The hourly Bandcamp sync (called by the Worker's cron trigger, cloudflare/worker.ts). Syncs every
 * account with Bandcamp set up that's due (at most hourly, as when someone opens the app).
 * Only with the CRON_SECRET; anything else gets a 404.
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET ?? "";
  const given = request.headers.get("x-cron-secret") ?? "";
  if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    return new Response("Not found", { status: 404 });
  }
  const accounts = await db
    .select({ orgId: schema.accountSettings.orgId })
    .from(schema.accountSettings)
    .where(or(isNotNull(schema.accountSettings.bandcampUrl), isNotNull(schema.accountSettings.bandcampClientId)));
  const results: Record<string, string> = {};
  for (const { orgId } of accounts) {
    try {
      const r = await syncAccount(orgId);
      results[orgId] = r.ran ? r.summary + (r.errors.length ? ` (${r.errors.length} problem(s))` : "") : "not due";
    } catch (e) {
      results[orgId] = `failed: ${(e as Error).message}`;
    }
  }
  return Response.json(results);
}
