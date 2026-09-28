import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// A throwaway database for these tests; must be set before the db module loads.
process.env.LABEL_DB = join(mkdtempSync(join(tmpdir(), "label-payouts-")), "test.db");

let db: typeof import("@/db").db;
let schema: typeof import("@/db").schema;
let people: typeof import("../people");

beforeAll(async () => {
  ({ db, schema } = await import("@/db"));
  people = await import("../people");
});

describe("merging people", () => {
  it("moves memberships, shares, costs and payouts onto one person, combining overlaps", () => {
    const { bands, people: p, bandMemberships: m, splitRules, splitShares, deductions, periods, payouts } = schema;
    const flag = db.insert(bands).values({ name: "Flag Day" }).returning().get();
    const sweet = db.insert(bands).values({ name: "Sweetums" }).returning().get();
    const a1 = db.insert(p).values({ name: "Archie O'Connell", email: "archie@example.com" }).returning().get();
    const a2 = db.insert(p).values({ name: "Archie O’Connell", email: "ARCHIE@example.com", paypalMe: "archie" }).returning().get();
    db.insert(m).values({ bandId: flag.id, personId: a1.id, roles: ["vocals"] }).run();
    db.insert(m).values({ bandId: flag.id, personId: a2.id, roles: ["guitar"] }).run();
    db.insert(m).values({ bandId: sweet.id, personId: a2.id, roles: ["drums"] }).run();
    const rule = db.insert(splitRules).values({ scope: "band_default", bandId: flag.id }).returning().get();
    db.insert(splitShares).values({ ruleId: rule.id, personId: a1.id, bps: 3000 }).run();
    db.insert(splitShares).values({ ruleId: rule.id, personId: a2.id, bps: 2000 }).run();
    db.insert(deductions).values({ label: "CD", kind: "per_unit", amountCents: 342, destination: "person", personId: a2.id }).run();
    const period = db
      .insert(periods)
      .values({ name: "Q1", startDate: "2026-01-01", endDate: "2026-03-31", status: "finalized" })
      .returning()
      .get();
    db.insert(payouts).values({ periodId: period.id, personId: a1.id, currency: "USD", amountCents: 1000, byBand: { [flag.id]: 1000 } }).run();
    db.insert(payouts)
      .values({ periodId: period.id, personId: a2.id, currency: "USD", amountCents: 500, byBand: { [sweet.id]: 500 }, status: "paid" })
      .run();

    // The second record is kept: both have a payout and a share, but it's in more bands.
    expect(people.autoMergeByEmail()).toEqual(["Archie O’Connell"]);

    const all = db.select().from(p).all();
    expect(all).toHaveLength(1);
    const archie = all[0];
    expect(archie.id).toBe(a2.id);
    expect(archie.paypalMe).toBe("archie");

    const memberships = db.select().from(m).all();
    expect(memberships.map((x) => [x.bandId, [...x.roles].sort()])).toEqual([
      [flag.id, ["guitar", "vocals"]],
      [sweet.id, ["drums"]],
    ]);
    expect(db.select().from(splitShares).all().map((s) => [s.personId, s.bps])).toEqual([[archie.id, 5000]]);
    expect(db.select().from(deductions).all()[0].personId).toBe(archie.id);
    const pay = db.select().from(payouts).all();
    expect(pay).toHaveLength(1);
    expect(pay[0]).toMatchObject({ personId: archie.id, amountCents: 1500, status: "pending" });
    expect(pay[0].byBand).toEqual({ [flag.id]: 1000, [sweet.id]: 500 });
  });

  it("finds an existing person to reuse by email, or by name when emails don't conflict", () => {
    const { people: p } = schema;
    db.insert(p).values({ name: "Tynan Reynolds", email: null }).run();
    db.insert(p).values({ name: "Billy Hessler", email: "billy@example.com" }).run();
    expect(people.findExistingPerson("Someone Else", "BILLY@example.com")?.name).toBe("Billy Hessler");
    expect(people.findExistingPerson("tynan  reynolds", "tynan@example.com")?.name).toBe("Tynan Reynolds");
    expect(people.findExistingPerson("Billy Hessler", "other@example.com")).toBeNull(); // a different Billy?
  });

  it("lists same-name people with different emails as possible duplicates", () => {
    const { people: p } = schema;
    db.insert(p).values({ name: "Billy Hessler", email: "other@example.com" }).run();
    expect(people.possibleDuplicates().map((g) => g.map((x) => x.email))).toEqual([["billy@example.com", "other@example.com"]]);
  });
});
