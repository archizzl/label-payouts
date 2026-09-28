import "server-only";
import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db, schema } from "@/db";
import { type Context, requireAdmin } from "./context";

/*
 * Links between a band's own account and its label's account. An active link gives the band
 * account's admins a read-only view of the label's books for that one band, nothing else.
 */

const { accountLinks, organization, bands } = schema;

/** The link (pending or active) for a band in the label's books, if any. */
export async function linkForLabelBand(labelOrgId: string, bandId: number) {
  const [row] = await db
    .select({ link: accountLinks, bandAccount: organization })
    .from(accountLinks)
    .leftJoin(organization, eq(organization.id, accountLinks.bandOrgId))
    .where(and(eq(accountLinks.labelOrgId, labelOrgId), eq(accountLinks.labelBandId, bandId)));
  return row ?? null;
}

/** Active links from a label's bands to their own accounts, by label band id. */
export async function linkedBandAccounts(labelOrgId: string) {
  const rows = await db
    .select({ bandId: accountLinks.labelBandId, name: organization.name })
    .from(accountLinks)
    .innerJoin(organization, eq(organization.id, accountLinks.bandOrgId))
    .where(and(eq(accountLinks.labelOrgId, labelOrgId), eq(accountLinks.status, "active")));
  return new Map(rows.map((r) => [r.bandId, r.name]));
}

/** The labels a band account is linked to. */
export async function labelsForBandAccount(bandOrgId: string) {
  return db
    .select({ link: accountLinks, label: organization, band: bands })
    .from(accountLinks)
    .innerJoin(organization, eq(organization.id, accountLinks.labelOrgId))
    .innerJoin(bands, eq(bands.id, accountLinks.labelBandId))
    .where(and(eq(accountLinks.bandOrgId, bandOrgId), eq(accountLinks.status, "active")))
    .orderBy(organization.name);
}

export type LinkedView = {
  ctx: Context;
  link: typeof accountLinks.$inferSelect;
  /** The label's account, whose books we read. */
  labelOrgId: string;
  labelName: string;
  /** The band, in the label's books. */
  bandId: number;
  bandName: string;
};

/**
 * For the read-only "from your label" pages: the signed-in admin of a band account, looking at a
 * label linked to it. Anything else is a 404, so nobody learns which links exist.
 */
export async function requireLinkedView(linkId: number): Promise<LinkedView> {
  const ctx = await requireAdmin();
  const [row] = await db
    .select({ link: accountLinks, label: organization, band: bands })
    .from(accountLinks)
    .innerJoin(organization, eq(organization.id, accountLinks.labelOrgId))
    .innerJoin(bands, eq(bands.id, accountLinks.labelBandId))
    .where(and(eq(accountLinks.id, linkId), eq(accountLinks.bandOrgId, ctx.orgId), eq(accountLinks.status, "active")));
  if (!row) notFound();
  return { ctx, link: row.link, labelOrgId: row.label.id, labelName: row.label.name, bandId: row.band.id, bandName: row.band.name };
}
