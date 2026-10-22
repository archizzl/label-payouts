import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db, schema } from "@/db";
import { getContext } from "@/server/context";
import { readStoredFile } from "@/server/receipt-store";

/**
 * A merch photo uploaded here (src/server/merch-photos.ts). For anyone signed in to its group, or to
 * a band group the label made (which shows the label's merch for its band).
 */
export async function GET(_req: NextRequest, ctx: RouteContext<"/merch/photo/[id]">) {
  const me = await getContext();
  const [photo] = await db
    .select()
    .from(schema.merchPhotos)
    .where(eq(schema.merchPhotos.id, Number((await ctx.params).id)));
  const notFound = new Response("Not found", { status: 404 });
  if (!photo || (photo.orgId !== me.orgId && photo.orgId !== me.managedBy?.labelOrgId)) return notFound;
  const body = await readStoredFile(photo);
  if (!body) return notFound;
  return new Response(body, {
    headers: {
      "Content-Type": photo.contentType,
      "Content-Length": String(photo.size),
      // A photo never changes (a new one gets a new address).
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
