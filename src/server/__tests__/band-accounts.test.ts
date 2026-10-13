import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { testDb } from "../../../test/helpers/db";

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let ba: typeof import("../band-accounts");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  ba = await import("../band-accounts");
});

async function label(kind: "label" | "band" = "label") {
  const id = randomUUID();
  await db.insert(schema.organization).values({ id, name: `Org ${id.slice(0, 4)}`, slug: `org-${id}`, createdAt: new Date(), kind });
  return id;
}

const band = async (orgId: string, name: string, isLabel = false) =>
  (await db.insert(schema.bands).values({ orgId, name, isLabel }).returning())[0];

const linksOf = (labelOrgId: string) => db.select().from(schema.accountLinks).where(eq(schema.accountLinks.labelOrgId, labelOrgId));

describe("band sub-accounts", () => {
  it("makes a linked band account for each of a label's bands, once", async () => {
    const orgId = await label();
    const a = await band(orgId, "Alpha");
    const b = await band(orgId, "Beta");
    await band(orgId, "The label itself", true);

    expect(await ba.ensureBandAccounts(orgId)).toBe(2);
    expect(await ba.ensureBandAccounts(orgId)).toBe(0);

    const links = await linksOf(orgId);
    expect(links.map((l) => l.labelBandId).sort()).toEqual([a.id, b.id].sort());
    expect(links.every((l) => l.managed && l.status === "active" && l.bandOrgId)).toBe(true);
    const sub = await ba.subAccountFor(orgId, a.id);
    expect(sub?.org).toMatchObject({ name: "Alpha", kind: "band" });
    const [settings] = await db.select().from(schema.accountSettings).where(eq(schema.accountSettings.orgId, sub!.org.id));
    expect(settings).toBeTruthy();
    expect(await ba.managingLabel(sub!.org.id)).toMatchObject({ labelOrgId: orgId, bandId: a.id, linkId: sub!.link.id });
  });

  it("replaces an unused link code, and leaves a band's own linked account alone", async () => {
    const orgId = await label();
    const waiting = await band(orgId, "Waiting");
    const own = await band(orgId, "Own");
    const ownOrg = await label("band");
    await db.insert(schema.accountLinks).values([
      { labelOrgId: orgId, labelBandId: waiting.id, code: `CODE-${randomUUID()}` },
      { labelOrgId: orgId, labelBandId: own.id, code: `CODE-${randomUUID()}`, bandOrgId: ownOrg, status: "active" },
    ]);

    expect(await ba.ensureBandAccounts(orgId)).toBe(1);
    const links = await linksOf(orgId);
    expect(links.find((l) => l.labelBandId === waiting.id)).toMatchObject({ managed: true, status: "active" });
    expect(links.find((l) => l.labelBandId === own.id)).toMatchObject({ managed: false, bandOrgId: ownOrg });
    expect(await ba.managingLabel(ownOrg)).toBeNull();
  });

  it("does nothing for a band account", async () => {
    const orgId = await label("band");
    await band(orgId, "Solo");
    expect(await ba.ensureBandAccounts(orgId)).toBe(0);
  });

  it("follows the band's name, and goes when the band does", async () => {
    const orgId = await label();
    const a = await band(orgId, "Old Name");
    await ba.ensureBandAccounts(orgId);
    const sub = (await ba.subAccountFor(orgId, a.id))!;

    await ba.renameSubAccount(orgId, a.id, "New Name");
    const [renamed] = await db.select().from(schema.organization).where(eq(schema.organization.id, sub.org.id));
    expect(renamed.name).toBe("New Name");

    await ba.deleteSubAccount(orgId, a.id);
    expect(await db.select().from(schema.organization).where(eq(schema.organization.id, sub.org.id))).toHaveLength(0);
    expect(await db.select().from(schema.accountLinks).where(and(eq(schema.accountLinks.labelOrgId, orgId), eq(schema.accountLinks.labelBandId, a.id)))).toHaveLength(0);
  });

  it("two at once still make one account per band", async () => {
    const orgId = await label();
    await band(orgId, "Racer");
    const made = await Promise.all([ba.ensureBandAccounts(orgId), ba.ensureBandAccounts(orgId)]);
    expect(made.reduce((x, y) => x + y, 0)).toBe(1);
    const subs = await db.select().from(schema.organization).where(eq(schema.organization.name, "Racer"));
    expect(subs).toHaveLength(1);
  });
});
