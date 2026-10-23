import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Context } from "../context";

/*
 * What an id in a change is called, for its confirm card: "Delete a deduction: CD costs", not "#3".
 * Only this group's items are found; anything else shows as its id.
 */

export type ItemKind =
  | "deduction"
  | "split"
  | "send-out"
  | "inventory item"
  | "expense"
  | "receipt file"
  | "project"
  | "payout"
  | "payout line"
  | "band membership"
  | "import"
  | "saved match"
  | "member type"
  | "pickup";

export async function itemName(ctx: Context, kind: ItemKind, id: number): Promise<string | null> {
  const s = schema;
  const org = ctx.orgId;
  switch (kind) {
    case "deduction": {
      const [r] = await db.select({ label: s.deductions.label }).from(s.deductions).where(and(eq(s.deductions.orgId, org), eq(s.deductions.id, id)));
      return r?.label ?? null;
    }
    case "split": {
      const [r] = await db
        .select({ scope: s.splitRules.scope, band: s.bands.name, release: s.releases.title, from: s.splitRules.effectiveFrom })
        .from(s.splitRules)
        .leftJoin(s.bands, eq(s.bands.id, s.splitRules.bandId))
        .leftJoin(s.releases, eq(s.releases.id, s.splitRules.releaseId))
        .where(and(eq(s.splitRules.orgId, org), eq(s.splitRules.id, id)));
      if (!r) return null;
      const what = r.release ? `${r.release}’s split` : r.band ? `${r.band}’s ${r.scope === "band_default" ? "split" : "item-type split"}` : "the label default split";
      return r.from && r.from > "2000-01-01" ? `${what} from ${r.from}` : what;
    }
    case "send-out": {
      const [r] = await db.select().from(s.labelTransfers).where(and(eq(s.labelTransfers.orgId, org), eq(s.labelTransfers.id, id)));
      return r ? `${r.recipient} (${r.date})` : null;
    }
    case "inventory item": {
      const [r] = await db.select().from(s.inventoryItems).where(and(eq(s.inventoryItems.orgId, org), eq(s.inventoryItems.id, id)));
      return r ? `${r.name}${r.option ? ` (${r.option})` : ""}` : null;
    }
    case "expense": {
      const [r] = await db.select().from(s.expenses).where(and(eq(s.expenses.orgId, org), eq(s.expenses.id, id)));
      return r ? `${r.description} (${r.date})` : null;
    }
    case "receipt file": {
      const [r] = await db.select({ name: s.expenseFiles.filename }).from(s.expenseFiles).where(and(eq(s.expenseFiles.orgId, org), eq(s.expenseFiles.id, id)));
      return r?.name ?? null;
    }
    case "project": {
      const [r] = await db.select({ name: s.projects.name }).from(s.projects).where(and(eq(s.projects.orgId, org), eq(s.projects.id, id)));
      return r?.name ?? null;
    }
    case "payout": {
      const [r] = await db.select({ name: s.periods.name }).from(s.periods).where(and(eq(s.periods.orgId, org), eq(s.periods.id, id)));
      return r ? `“${r.name}”` : null;
    }
    case "payout line": {
      const [r] = await db
        .select({ person: s.people.name, period: s.periods.name })
        .from(s.payouts)
        .innerJoin(s.people, eq(s.people.id, s.payouts.personId))
        .innerJoin(s.periods, eq(s.periods.id, s.payouts.periodId))
        .where(and(eq(s.payouts.orgId, org), eq(s.payouts.id, id)));
      return r ? `${r.person} in “${r.period}”` : null;
    }
    case "band membership": {
      const [r] = await db
        .select({ person: s.people.name, band: s.bands.name })
        .from(s.bandMemberships)
        .innerJoin(s.people, eq(s.people.id, s.bandMemberships.personId))
        .innerJoin(s.bands, eq(s.bands.id, s.bandMemberships.bandId))
        .where(and(eq(s.bandMemberships.orgId, org), eq(s.bandMemberships.id, id)));
      return r ? `${r.person} in ${r.band}` : null;
    }
    case "import": {
      const [r] = await db.select().from(s.imports).where(and(eq(s.imports.orgId, org), eq(s.imports.id, id)));
      return r ? `${r.filename} (${r.addedCount} sales)` : null;
    }
    case "saved match": {
      const [r] = await db.select({ key: s.routingOverrides.matchKey }).from(s.routingOverrides).where(and(eq(s.routingOverrides.orgId, org), eq(s.routingOverrides.id, id)));
      return r?.key ?? null;
    }
    case "member type": {
      const [r] = await db.select({ name: s.memberTypes.name }).from(s.memberTypes).where(and(eq(s.memberTypes.orgId, org), eq(s.memberTypes.id, id)));
      return r?.name ?? null;
    }
    case "pickup": {
      const [r] = await db.select().from(s.pickupOrders).where(and(eq(s.pickupOrders.orgId, org), eq(s.pickupOrders.id, id)));
      return r ? `${r.buyerName.split(" ")[0]}’s order (${r.orderDate})` : null;
    }
  }
}
