import { beforeAll, describe, expect, it } from "vitest";
import { newAccount, testDb } from "../../../test/helpers/db";

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let people: typeof import("../people");
let orgId: string;

beforeAll(async () => {
  ({ db, schema } = await testDb());
  people = await import("../people");
  orgId = await newAccount();
});

describe("merging people", () => {
  it("moves memberships, shares, costs and payouts onto one person, combining overlaps", async () => {
    const { bands, people: p, bandMemberships: m, splitRules, splitShares, deductions, periods, payouts } = schema;
    const [flag] = await db.insert(bands).values({ orgId, name: "Flag Day" }).returning();
    const [sweet] = await db.insert(bands).values({ orgId, name: "Sweetums" }).returning();
    const [a1] = await db.insert(p).values({ orgId, name: "Archie O'Connell", email: "archie@example.com" }).returning();
    const [a2] = await db.insert(p).values({ orgId, name: "Archie O’Connell", email: "ARCHIE@example.com", paypalMe: "archie" }).returning();
    await db.insert(m).values([
      { orgId, bandId: flag.id, personId: a1.id, roles: ["vocals"] },
      { orgId, bandId: flag.id, personId: a2.id, roles: ["guitar"] },
      { orgId, bandId: sweet.id, personId: a2.id, roles: ["drums"] },
    ]);
    const [rule] = await db.insert(splitRules).values({ orgId, scope: "band_default", bandId: flag.id }).returning();
    await db.insert(splitShares).values([
      { orgId, ruleId: rule.id, personId: a1.id, bps: 3000 },
      { orgId, ruleId: rule.id, personId: a2.id, bps: 2000 },
    ]);
    await db.insert(deductions).values({ orgId, label: "CD", kind: "per_unit", amountCents: 342, destination: "person", personId: a2.id });
    const [period] = await db
      .insert(periods)
      .values({ orgId, name: "Q1", startDate: "2026-01-01", endDate: "2026-03-31", status: "finalized" })
      .returning();
    await db.insert(payouts).values([
      { orgId, periodId: period.id, personId: a1.id, currency: "USD", amountCents: 1000, byBand: { [flag.id]: 1000 } },
      { orgId, periodId: period.id, personId: a2.id, currency: "USD", amountCents: 500, byBand: { [sweet.id]: 500 }, status: "paid" },
    ]);

    // The second record is kept: both have a payout and a share, but it's in more bands.
    expect(await people.autoMergeByEmail(orgId)).toEqual(["Archie O’Connell"]);

    const all = await db.select().from(p);
    expect(all).toHaveLength(1);
    const archie = all[0];
    expect(archie.id).toBe(a2.id);
    expect(archie.paypalMe).toBe("archie");

    const memberships = (await db.select().from(m)).sort((x, y) => x.bandId - y.bandId);
    expect(memberships.map((x) => [x.bandId, [...x.roles].sort()])).toEqual([
      [flag.id, ["guitar", "vocals"]],
      [sweet.id, ["drums"]],
    ]);
    expect((await db.select().from(splitShares)).map((s) => [s.personId, s.bps])).toEqual([[archie.id, 5000]]);
    expect((await db.select().from(deductions))[0].personId).toBe(archie.id);
    const pay = await db.select().from(payouts);
    expect(pay).toHaveLength(1);
    expect(pay[0]).toMatchObject({ personId: archie.id, amountCents: 1500, status: "pending" });
    expect(pay[0].byBand).toEqual({ [flag.id]: 1000, [sweet.id]: 500 });
  });

  it("finds an existing person to reuse by email, or by name when emails don't conflict", async () => {
    const { people: p } = schema;
    await db.insert(p).values([
      { orgId, name: "Tynan Reynolds", email: null },
      { orgId, name: "Billy Hessler", email: "billy@example.com" },
    ]);
    expect((await people.findExistingPerson(orgId, "Someone Else", "BILLY@example.com"))?.name).toBe("Billy Hessler");
    expect((await people.findExistingPerson(orgId, "tynan  reynolds", "tynan@example.com"))?.name).toBe("Tynan Reynolds");
    expect(await people.findExistingPerson(orgId, "Billy Hessler", "other@example.com")).toBeNull(); // a different Billy?
  });

  it("lists same-name people with different emails as possible duplicates", async () => {
    await db.insert(schema.people).values({ orgId, name: "Billy Hessler", email: "other@example.com" });
    expect((await people.possibleDuplicates(orgId)).map((g) => g.map((x) => x.email).sort())).toEqual([["billy@example.com", "other@example.com"]]);
  });

  it("never looks at another account's people", async () => {
    const other = await newAccount("Another Label");
    await db.insert(schema.people).values({ orgId: other, name: "Billy Hessler", email: "billy@example.com" });
    expect(await people.findExistingPerson(other, "Tynan Reynolds", null)).toBeNull();
    expect(await people.possibleDuplicates(other)).toEqual([]);
    // Same email in two accounts: two different people, never merged.
    expect(await people.autoMergeByEmail(orgId)).toEqual([]);
    expect(await people.autoMergeByEmail(other)).toEqual([]);
  });
});
