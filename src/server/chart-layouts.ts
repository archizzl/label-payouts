import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { accountContext } from "./context";

/** This person's saved layout for a chart area in this account, or null (use the defaults). */
export async function loadLayout(boardId: string): Promise<unknown> {
  // The account they're in as itself (a band's own account, not the label's books it looks at),
  // the same account saveChartLayout stores it under.
  const { user, orgId } = await accountContext();
  const [row] = await db
    .select({ layout: schema.chartLayouts.layout })
    .from(schema.chartLayouts)
    .where(and(eq(schema.chartLayouts.userId, user.id), eq(schema.chartLayouts.orgId, orgId), eq(schema.chartLayouts.boardId, boardId)));
  return row?.layout ?? null;
}
