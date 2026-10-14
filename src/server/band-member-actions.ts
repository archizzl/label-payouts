"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { cleanCashtag, cleanVenmoHandle } from "@/lib/paypal-export";
import { accountContext } from "./context";

export type DetailsState = { ok?: string; error?: string } | null;

/**
 * A member's own login on a band's account: update their details in the label's books (name, their
 * roles in this band, and how they're paid). Only their own record, never anyone else's.
 */
export async function saveMyDetails(_: DetailsState, fd: FormData): Promise<DetailsState> {
  const ctx = await accountContext();
  const m = ctx.managedBy;
  if (!m) return { error: "Only a band member’s own login has details to change here." };
  const [own] = await db
    .select({ personId: schema.bandLoginPeople.personId })
    .from(schema.bandLoginPeople)
    .where(and(eq(schema.bandLoginPeople.orgId, ctx.orgId), eq(schema.bandLoginPeople.userId, ctx.user.id)));
  if (!own) return { error: "This login is the band’s, not one member’s." };
  const text = (k: string) => String(fd.get(k) ?? "").trim().slice(0, 200);
  const name = text("name");
  if (!name) return { error: "Enter your name." };
  await db
    .update(schema.people)
    .set({
      name,
      email: text("email") || null,
      paypalMe: text("paypalMe").replace(/^(https?:\/\/)?(www\.)?paypal\.me\//i, "") || null,
      venmo: cleanVenmoHandle(text("venmo")) || null,
      cashtag: cleanCashtag(text("cashtag")) || null,
    })
    .where(and(eq(schema.people.orgId, m.labelOrgId), eq(schema.people.id, own.personId)));
  const roles = text("roles")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  await db
    .update(schema.bandMemberships)
    .set({ roles })
    .where(and(eq(schema.bandMemberships.orgId, m.labelOrgId), eq(schema.bandMemberships.bandId, m.bandId), eq(schema.bandMemberships.personId, own.personId)));
  revalidatePath("/", "layout");
  return { ok: "Saved." };
}
