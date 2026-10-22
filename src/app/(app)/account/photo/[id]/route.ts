import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db, schema } from "@/db";
import { getSession } from "@/server/context";
import { readStoredFile } from "@/server/receipt-store";

/** Someone's profile photo (src/server/profile-photos.ts), for anyone signed in. */
export async function GET(_req: NextRequest, ctx: RouteContext<"/account/photo/[id]">) {
  const notFound = new Response("Not found", { status: 404 });
  if (!(await getSession())) return notFound;
  const [photo] = await db
    .select()
    .from(schema.profilePhotos)
    .where(eq(schema.profilePhotos.id, Number((await ctx.params).id)));
  if (!photo) return notFound;
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
