import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { newAccount, testDb } from "../../../test/helpers/db";

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let context: typeof import("../context");
let types: typeof import("../member-types");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  context = await import("../context");
  types = await import("../member-types");
});

async function login(name: string) {
  const id = randomUUID();
  await db.insert(schema.user).values({ id, name, email: `${id}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  return id;
}

describe("member types", () => {
  it("give a member what their type allows, limited to the bands they're in", async () => {
    const orgId = await newAccount();
    const userId = await login("Manager");
    const [band] = await db.insert(schema.bands).values({ orgId, name: "Flag Day" }).returning();
    await db.insert(schema.bands).values({ orgId, name: "Someone Else" });
    const [person] = await db.insert(schema.people).values({ orgId, name: "Manager", userId }).returning();
    await db.insert(schema.bandMemberships).values({ orgId, bandId: band.id, personId: person.id });
    const [t] = await db.insert(schema.memberTypes).values({ orgId, name: "Band manager", permissions: { orders: "edit" }, bandAreas: ["orders"] }).returning();

    // No type yet: nothing beyond their own earnings.
    let { access } = await context.accessFor(orgId, userId, false, person.id);
    expect(access.permissions).toEqual({});

    await types.assignMemberType(orgId, userId, t.id);
    const result = await context.accessFor(orgId, userId, false, person.id);
    expect(result.memberType).toBe("Band manager");
    access = result.access;
    expect(access.permissions).toEqual({ orders: "edit" });
    expect(access.bandIds).toEqual([band.id]);

    // Deleting the type takes it away.
    await db.delete(schema.memberTypes).where((await import("drizzle-orm")).eq(schema.memberTypes.id, t.id));
    expect((await context.accessFor(orgId, userId, false, person.id)).access.permissions).toEqual({});
  });

  it("use the bands someone manages, when picked, instead of the ones they play in", async () => {
    const orgId = await newAccount();
    const userId = await login("Mo Manager");
    const [a] = await db.insert(schema.bands).values({ orgId, name: "Band A" }).returning();
    const [b] = await db.insert(schema.bands).values({ orgId, name: "Band B" }).returning();
    const [person] = await db.insert(schema.people).values({ orgId, name: "Mo Manager", userId }).returning();
    await db.insert(schema.bandMemberships).values({ orgId, bandId: a.id, personId: person.id });
    const [t] = await db
      .insert(schema.memberTypes)
      .values({ orgId, name: "Band manager", permissions: { receipts: "edit", roster: "view" }, bandAreas: ["receipts", "roster"] })
      .returning();
    await types.assignMemberType(orgId, userId, t.id);

    expect((await context.accessFor(orgId, userId, false, person.id)).access.bandIds).toEqual([a.id]);
    // They manage Band B (without playing in it).
    await types.setManagedBands(orgId, userId, [b.id]);
    expect((await context.accessFor(orgId, userId, false, person.id)).access).toMatchObject({ bandIds: [b.id], bandAreas: ["receipts", "roster"] });
    // Changing their type keeps the bands they manage; going back to "the bands they play in" too.
    await types.assignMemberType(orgId, userId, t.id);
    expect((await types.managedBandsOf(orgId)).get(userId)).toEqual([b.id]);
    await types.setManagedBands(orgId, userId, null);
    expect((await context.accessFor(orgId, userId, false, person.id)).access.bandIds).toEqual([a.id]);
  });

  it("doesn't look up their bands when nothing in their type is limited to them", async () => {
    const orgId = await newAccount();
    const userId = await login("Viewer");
    const [band] = await db.insert(schema.bands).values({ orgId, name: "Flag Day" }).returning();
    const [person] = await db.insert(schema.people).values({ orgId, name: "Viewer", userId }).returning();
    await db.insert(schema.bandMemberships).values({ orgId, bandId: band.id, personId: person.id });
    const [t] = await db.insert(schema.memberTypes).values({ orgId, name: "Viewer", permissions: { sales: "view" } }).returning();
    await types.assignMemberType(orgId, userId, t.id);
    const { access } = await context.accessFor(orgId, userId, false, person.id);
    expect(access).toEqual({ admin: false, permissions: { sales: "view" }, bandAreas: [], bandIds: [] });
    expect((await context.accessFor(orgId, userId, true, person.id)).access.admin).toBe(true);
  });

  it("only accepts a member type from the same account", async () => {
    const orgA = await newAccount("A");
    const orgB = await newAccount("B");
    const [t] = await db.insert(schema.memberTypes).values({ orgId: orgA, name: "Manager" }).returning();
    expect(await types.parseRoleChoice(orgA, `type:${t.id}`)).toEqual({ role: "member", memberTypeId: t.id });
    await expect(types.parseRoleChoice(orgB, `type:${t.id}`)).rejects.toThrow();
    expect(await types.parseRoleChoice(orgB, "admin")).toEqual({ role: "admin", memberTypeId: null });
    expect(await types.parseRoleChoice(orgB, "whatever")).toEqual({ role: "member", memberTypeId: null });
  });
});
