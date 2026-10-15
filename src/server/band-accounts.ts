import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray, TransactionRollbackError } from "drizzle-orm";
import { db, schema } from "@/db";
import { slugify } from "@/lib/slug";

/*
 * Band sub-accounts. Every band on a label gets its own band account, made by the label and linked
 * to it straight away (an account link with `managed` set; src/server/links.ts). Whoever the label
 * invites to it sees what the label has for that band, read-only. Label admins can look at it too,
 * with "view as" (src/server/context.ts). Bands that already had their own account linked keep it.
 */

const { accountLinks, bands, organization } = schema;

/** Short and unguessable: the link code is unused for these, but the column needs one. */
const token = (n: number) => randomBytes(n).toString("hex");

/**
 * Make a sub-account for each of a label's bands that doesn't have an account linked yet (an unused
 * link code from before is replaced). Safe to call any time; it does nothing once they all have one.
 * Returns how many it made.
 */
export async function ensureBandAccounts(labelOrgId: string): Promise<number> {
  const [label] = await db.select({ kind: organization.kind }).from(organization).where(eq(organization.id, labelOrgId));
  if (label?.kind !== "label") return 0;
  const [labelBands, links] = await Promise.all([
    db
      .select({ id: bands.id, name: bands.name })
      .from(bands)
      .where(and(eq(bands.orgId, labelOrgId), eq(bands.isLabel, false))),
    db.select().from(accountLinks).where(eq(accountLinks.labelOrgId, labelOrgId)),
  ]);
  const linked = new Set(links.filter((l) => l.status === "active").map((l) => l.labelBandId));
  const missing = labelBands.filter((b) => !linked.has(b.id));
  if (!missing.length) return 0;
  // Old link codes nobody used: the sub-account takes their place.
  const stale = links.filter((l) => l.status === "pending" && missing.some((b) => b.id === l.labelBandId)).map((l) => l.id);
  if (stale.length) await db.delete(accountLinks).where(inArray(accountLinks.id, stale));

  let made = 0;
  for (const band of missing) {
    const now = new Date();
    const orgId = randomUUID();
    const created = await db.transaction(async (tx) => {
      await tx.insert(organization).values({ id: orgId, name: band.name, slug: `${slugify(band.name) || "band"}-${token(3)}`, createdAt: now, kind: "band" });
      await tx.insert(schema.accountSettings).values({ orgId });
      const [link] = await tx
        .insert(accountLinks)
        .values({ labelOrgId, labelBandId: band.id, bandOrgId: orgId, code: token(8), status: "active", acceptedAt: now.toISOString(), managed: true })
        .onConflictDoNothing()
        .returning({ id: accountLinks.id });
      // Another request made it first: keep theirs.
      if (!link) tx.rollback();
      return true;
    }).catch((e) => {
      if (e instanceof TransactionRollbackError) return false;
      throw e;
    });
    if (created) made++;
  }
  return made;
}

/** The sub-account for a band in a label's books, if the label made one. */
export async function subAccountFor(labelOrgId: string, bandId: number) {
  const [row] = await db
    .select({ link: accountLinks, org: organization })
    .from(accountLinks)
    .innerJoin(organization, eq(organization.id, accountLinks.bandOrgId))
    .where(and(eq(accountLinks.labelOrgId, labelOrgId), eq(accountLinks.labelBandId, bandId), eq(accountLinks.managed, true), eq(accountLinks.status, "active")));
  return row ?? null;
}

/** If this band account is a label's sub-account: the link, and the label's name. */
export async function managingLabel(bandOrgId: string) {
  const [row] = await db
    .select({
      linkId: accountLinks.id,
      labelOrgId: accountLinks.labelOrgId,
      bandId: accountLinks.labelBandId,
      labelName: organization.name,
    })
    .from(accountLinks)
    .innerJoin(organization, eq(organization.id, accountLinks.labelOrgId))
    .where(and(eq(accountLinks.bandOrgId, bandOrgId), eq(accountLinks.managed, true), eq(accountLinks.status, "active")));
  return row ?? null;
}

/** A band was renamed in the label's books: its sub-account follows. */
export async function renameSubAccount(labelOrgId: string, bandId: number, name: string) {
  const row = await subAccountFor(labelOrgId, bandId);
  if (row && row.org.name !== name) await db.update(organization).set({ name }).where(eq(organization.id, row.org.id));
}

/** A band is being deleted from the label's books: its sub-account goes with it. */
export async function deleteSubAccount(labelOrgId: string, bandId: number) {
  const row = await subAccountFor(labelOrgId, bandId);
  if (row) await db.delete(organization).where(eq(organization.id, row.org.id));
}

export type BandAccountSummary = {
  /** The label made it (a sub-account), or the band linked an account it had already. */
  managed: boolean;
  name: string;
  /** People who sign in to it, and invites waiting. */
  logins: number;
  invited: number;
  /** Invites waiting, for copying their links from the directory. */
  invites: { id: string; email: string }[];
  /** The band's own account (for its invite link). */
  orgId: string;
};

/** Each of a label's bands' accounts, by band id: for the directory. */
export async function bandAccountSummaries(labelOrgId: string): Promise<Map<number, BandAccountSummary>> {
  const links = await db
    .select({ bandId: accountLinks.labelBandId, orgId: accountLinks.bandOrgId, managed: accountLinks.managed, name: organization.name })
    .from(accountLinks)
    .innerJoin(organization, eq(organization.id, accountLinks.bandOrgId))
    .where(and(eq(accountLinks.labelOrgId, labelOrgId), eq(accountLinks.status, "active")));
  const orgIds = links.map((l) => l.orgId!).filter(Boolean);
  const [members, invites] = orgIds.length
    ? await Promise.all([
        db.select({ orgId: schema.member.organizationId }).from(schema.member).where(inArray(schema.member.organizationId, orgIds)),
        db
          .select({ id: schema.invitation.id, email: schema.invitation.email, orgId: schema.invitation.organizationId, expiresAt: schema.invitation.expiresAt })
          .from(schema.invitation)
          .where(and(inArray(schema.invitation.organizationId, orgIds), eq(schema.invitation.status, "pending"))),
      ])
    : [[], []];
  const now = new Date();
  return new Map(
    links.map((l) => {
      const open = invites.filter((i) => i.orgId === l.orgId && i.expiresAt > now).map((i) => ({ id: i.id, email: i.email }));
      return [
        l.bandId,
        {
          managed: l.managed,
          name: l.name,
          logins: members.filter((m) => m.orgId === l.orgId).length,
          invited: open.length,
          invites: open,
          orgId: l.orgId!,
        },
      ];
    }),
  );
}
