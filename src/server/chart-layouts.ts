import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getContext } from "./context";

/** This person's saved layout for a chart area in this account, or null (use the defaults). */
export async function loadLayout(boardId: string): Promise<unknown> {
  const { user, orgId } = await getContext();
  const [row] = await db
    .select({ layout: schema.chartLayouts.layout })
    .from(schema.chartLayouts)
    .where(and(eq(schema.chartLayouts.userId, user.id), eq(schema.chartLayouts.orgId, orgId), eq(schema.chartLayouts.boardId, boardId)));
  return row?.layout ?? null;
}
