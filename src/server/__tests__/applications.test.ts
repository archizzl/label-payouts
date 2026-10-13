import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { testDb } from "../../../test/helpers/db";

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let apps: typeof import("../applications");
let auth: typeof import("../auth");

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret";
  ({ db, schema } = await testDb());
  auth = await import("../auth");
  apps = await import("../applications");
});

async function applicant(name = "Ada Lovelace") {
  const email = `${randomUUID().slice(0, 8)}@example.test`;
  const { user } = await auth.auth.api.signUpEmail({ body: { name, email, password: "a-long-password" } });
  return user;
}

describe("account applications", () => {
  it("approving a band sets up the account, its band and members, and invites for those with an email", async () => {
    const me = await applicant();
    const [app] = await db
      .insert(schema.accountApplications)
      .values({
        userId: me.id,
        kind: "band",
        name: "Flag Day",
        bandcampUrl: "https://flagday.bandcamp.com",
        members: [
          { name: "Ada Lovelace", role: "drums", email: null },
          { name: "Bea", role: "bass", email: "bea@example.test" },
          { name: "Cy", role: null, email: null },
        ],
      })
      .returning();
    const orgId = await apps.approveApplication(app.id, me.id);

    const [org] = await db.select().from(schema.organization).where(eq(schema.organization.id, orgId));
    expect(org).toMatchObject({ name: "Flag Day", kind: "band" });
    const [owner] = await db.select().from(schema.member).where(eq(schema.member.organizationId, orgId));
    expect(owner).toMatchObject({ userId: me.id, role: "owner" });
    const [settings] = await db.select().from(schema.accountSettings).where(eq(schema.accountSettings.orgId, orgId));
    expect(settings.bandcampUrl).toBe("https://flagday.bandcamp.com");
    const [band] = await db.select().from(schema.bands).where(eq(schema.bands.orgId, orgId));
    expect(band).toMatchObject({ name: "Flag Day", urlPatterns: ["flagday"] });
    const people = await db.select().from(schema.people).where(eq(schema.people.orgId, orgId));
    expect(people.map((p) => p.name).sort()).toEqual(["Ada Lovelace", "Bea", "Cy"]);
    expect(people.find((p) => p.name === "Ada Lovelace")?.userId).toBe(me.id);
    const memberships = await db.select().from(schema.bandMemberships).where(eq(schema.bandMemberships.orgId, orgId));
    expect(memberships).toHaveLength(3);
    const invites = await db.select().from(schema.invitation).where(eq(schema.invitation.organizationId, orgId));
    expect(invites.map((i) => i.email)).toEqual(["bea@example.test"]);
    const [done] = await db.select().from(schema.accountApplications).where(eq(schema.accountApplications.id, app.id));
    expect(done).toMatchObject({ status: "approved", orgId });
    // Can't approve twice.
    await expect(apps.approveApplication(app.id, me.id)).rejects.toThrow(/isn't waiting/);
  });

  it("approving a label adds its artists as bands and invites its team", async () => {
    const me = await applicant("Max");
    const [app] = await db
      .insert(schema.accountApplications)
      .values({
        userId: me.id,
        kind: "label",
        name: "Reaction Future",
        artists: [{ name: "Sweetums", bandcampUrl: "https://sweetumsofthebody.bandcamp.com" }, { name: "Allopath", bandcampUrl: null }],
        team: [{ name: "Jo", email: "jo@example.test" }],
      })
      .returning();
    const orgId = await apps.approveApplication(app.id, me.id);
    const bands = await db.select().from(schema.bands).where(eq(schema.bands.orgId, orgId));
    expect(bands.map((b) => [b.name, b.urlPatterns])).toEqual([["Sweetums", ["sweetumsofthebody"]], ["Allopath", []]]);
    const invites = await db.select().from(schema.invitation).where(eq(schema.invitation.organizationId, orgId));
    expect(invites.map((i) => i.email)).toEqual(["jo@example.test"]);
  });

  it("rejecting keeps the note for them, and they can see their latest application", async () => {
    const me = await applicant("Zed");
    const [app] = await db.insert(schema.accountApplications).values({ userId: me.id, kind: "band", name: "Nope" }).returning();
    await apps.rejectApplication(app.id, me.id, "Not a music project");
    expect(await apps.latestApplication(me.id)).toMatchObject({ status: "rejected", reviewNote: "Not a music project" });
    expect(await apps.preapproved(me.id)).toBe(false);
  });
});
