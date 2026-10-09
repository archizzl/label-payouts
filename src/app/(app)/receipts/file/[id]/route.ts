import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db, schema } from "@/db";
import { getContext } from "@/server/context";
import { can } from "@/lib/permissions";
import { canViewReceipt } from "@/server/expenses";

/**
 * A receipt photo or PDF. Only for: admins of the account it belongs to (and members who can see
 * receipts), the person who submitted
 * or paid it, and admins of a band account linked to that expense's band.
 */
export async function GET(_req: NextRequest, ctx: RouteContext<"/receipts/file/[id]">) {
  const me = await getContext();
  const [row] = await db
    .select({ file: schema.expenseFiles, expense: schema.expenses })
    .from(schema.expenseFiles)
    .innerJoin(schema.expenses, eq(schema.expenses.id, schema.expenseFiles.expenseId))
    .where(eq(schema.expenseFiles.id, Number((await ctx.params).id)));
  const notFound = new Response("Not found", { status: 404 });
  if (!row) return notFound;
  const { file, expense } = row;

  const allowed = await canViewReceipt(
    { orgId: me.orgId, isAdmin: me.isAdmin, userId: me.user.id, personId: me.person?.id ?? null, seesReceipts: can(me.access, "receipts") },
    expense,
  );
  if (!allowed) return notFound;

  return new Response(Buffer.from(file.data), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Length": String(file.size),
      // Shown in the browser; the name is kept for "save as".
      "Content-Disposition": `inline; filename="${file.filename.replace(/[^\w.\- ]+/g, "_")}"`,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
