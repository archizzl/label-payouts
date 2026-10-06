"use server";

import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { isLayoutShape } from "@/lib/chart-layout";
import { getContext } from "./context";

/*
 * Saving a person's chart layouts. Anyone signed in can arrange their own charts; layouts belong to
 * the person and the account, never anyone else's.
 */

const BOARD = /^[a-z0-9-]{1,40}$/;

export async function saveChartLayout(boardId: string, layout: unknown) {
  const { user, orgId } = await getContext();
  if (!BOARD.test(boardId) || !isLayoutShape(layout)) return;
  const clean = layout.map(({ uid, kind, format }) => ({ uid, kind, format }));
  await db
    .insert(schema.chartLayouts)
    .values({ userId: user.id, orgId, boardId, layout: clean })
    .onConflictDoUpdate({
      target: [schema.chartLayouts.userId, schema.chartLayouts.orgId, schema.chartLayouts.boardId],
      set: { layout: clean, updatedAt: new Date().toISOString().replace("T", " ").slice(0, 19) },
    });
}

export async function resetChartLayout(boardId: string) {
  const { user, orgId } = await getContext();
  if (!BOARD.test(boardId)) return;
  await db
    .delete(schema.chartLayouts)
    .where(and(eq(schema.chartLayouts.userId, user.id), eq(schema.chartLayouts.orgId, orgId), eq(schema.chartLayouts.boardId, boardId)));
}
