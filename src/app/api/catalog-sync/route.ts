import { timingSafeEqual } from "node:crypto";
import { clearCatalogSync, pendingCatalogSyncs } from "@/server/catalog-requests";

/*
 * For the Mac running `npm run sync-catalog`: GET lists the accounts waiting on a "Sync now", POST
 * {orgId, before} clears one once it's done. Only with CATALOG_SYNC_SECRET; anything else is a 404.
 */

function allowed(request: Request) {
  const secret = process.env.CATALOG_SYNC_SECRET ?? "";
  const given = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  return !!secret && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

const notFound = () => new Response("Not found", { status: 404 });

export async function GET(request: Request) {
  if (!allowed(request)) return notFound();
  return Response.json({ requests: await pendingCatalogSyncs() });
}

export async function POST(request: Request) {
  if (!allowed(request)) return notFound();
  const { orgId, before } = (await request.json().catch(() => ({}))) as { orgId?: string; before?: string };
  if (typeof orgId !== "string" || typeof before !== "string") return new Response("Bad request", { status: 400 });
  await clearCatalogSync(orgId, before);
  return Response.json({ ok: true });
}
