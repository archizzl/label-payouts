import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";

/*
 * What Abel's change tools share: how they ask for dates and amounts, and the item an edit starts
 * from (the app's save actions write every field, so an edit sends the current values for the
 * fields it doesn't change).
 */

export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");
export const amount = z.string().regex(/^-?\d+(\.\d{1,2})?$/, "an amount like 12.50");
export const currency = z.string().length(3).describe("Three-letter currency code, like USD");
export const id = z.number().int();

/** Cents as the amount the app's forms take ("12.50"). */
export const toAmount = (cents: number | null | undefined) => (cents === null || cents === undefined ? undefined : (cents / 100).toFixed(2));

type Table = (typeof schema)[
  | "bands"
  | "people"
  | "releases"
  | "tracks"
  | "deductions"
  | "labelTransfers"
  | "inventoryItems"
  | "expenses"
  | "bandMemberships"
  | "projects"];

/** One of this account's rows, to edit (an error if it isn't theirs). */
export async function current<T extends Table>(table: T, orgId: string, rowId: number, what: string): Promise<T["$inferSelect"]> {
  const [row] = await db
    .select()
    .from(table as typeof schema.bands)
    .where(and(eq((table as typeof schema.bands).orgId, orgId), eq((table as typeof schema.bands).id, rowId)));
  if (!row) throw new Error(`No such ${what} in this group.`);
  return row as T["$inferSelect"];
}

/** The argument if given, else the current value. */
export const or = <V>(given: V | undefined, now: V) => (given === undefined ? now : given);
