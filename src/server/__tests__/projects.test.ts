import { beforeAll, describe, expect, it } from "vitest";
import { newAccount, testDb } from "../../../test/helpers/db";

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let data: typeof import("../data");
let projects: typeof import("../projects");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  data = await import("../data");
  projects = await import("../projects");
});

/**
 * A label with one band: an album and an unrelated single, a 20% label cut, one member with 100%,
 * and sales: $100 of the album in March, $50 in May, $30 of the single in March.
 */
async function setup() {
  const orgId = await newAccount();
  const { bands, people, splitRules, splitShares, deductions, releases, imports, sales } = schema;
  const [band] = await db.insert(bands).values({ orgId, name: "Flag Day" }).returning();
  const [member] = await db.insert(people).values({ orgId, name: "Member" }).returning();
  const [rule] = await db.insert(splitRules).values({ orgId, scope: "band_default", bandId: band.id }).returning();
  await db.insert(splitShares).values({ orgId, ruleId: rule.id, personId: member.id, bps: 10000 });
  await db.insert(deductions).values({ orgId, label: "Label cut", kind: "percent", percentBps: 2000, destination: "label" });
  const [album] = await db.insert(releases).values({ orgId, bandId: band.id, title: "Album" }).returning();
  const [single] = await db.insert(releases).values({ orgId, bandId: band.id, title: "Single", kind: "track" }).returning();
  const [imp] = await db.insert(imports).values({ orgId, filename: "t", rowCount: 3, addedCount: 3, duplicateCount: 0 }).returning();
  const sale = (key: string, releaseId: number, date: string, netCents: number) =>
    db.insert(sales).values({
      orgId, importId: imp.id, dedupeKey: key, date, itemType: "album", category: "album", itemName: key, artist: "",
      itemUrl: "", packageName: "", currency: "USD", netCents, transactionId: key, routingKey: key, bandId: band.id, releaseId, raw: {},
    });
  await sale("a1", album.id, "2026-03-10", 10000);
  await sale("a2", album.id, "2026-05-10", 5000);
  await sale("s1", single.id, "2026-03-12", 3000);
  const [project] = await db.insert(schema.projects).values({ orgId, name: "The album", bandId: band.id }).returning();
  await db.insert(schema.projectReleases).values({ orgId, projectId: project.id, releaseId: album.id });
  return { orgId, band, member, album, single, project };
}

const expense = (orgId: string, v: Partial<typeof schema.expenses.$inferInsert>) =>
  db
    .insert(schema.expenses)
    .values({ orgId, date: "2026-01-15", description: "x", amountCents: 1000, paidBy: "label", status: "approved", ...v })
    .returning()
    .then((r) => r[0]);

describe("projects", () => {
  it("compares what was spent with what the project's releases made back", async () => {
    const { orgId, band, project } = await setup();
    await expense(orgId, { projectId: project.id, bandId: band.id, amountCents: 20000, category: "Studio time", date: "2026-01-15" });
    await expense(orgId, { projectId: project.id, bandId: band.id, amountCents: 5000, category: "Mixing", date: "2026-02-01" });
    await expense(orgId, { projectId: project.id, amountCents: 999, status: "pending" });
    await expense(orgId, { projectId: project.id, amountCents: 777, status: "rejected" });
    await expense(orgId, { amountCents: 123456 }); // not this project's

    const n = (await projects.projectNumbers(orgId)).get(project.id)!;
    expect(n.spent).toBe(25000);
    expect(n.pending).toBe(999);
    expect(n.madeBack).toBe(15000); // only the album, not the single
    expect(n.balance).toBe(-10000);
    expect(n.labelKept).toBe(3000); // 20% of the album's sales
    expect(n.toPeople).toBe(12000);
    expect(n.byCategory).toEqual([
      { category: "Studio time", cents: 20000 },
      { category: "Mixing", cents: 5000 },
    ]);
    expect(n.byRelease.map((r) => [r.title, r.net])).toEqual([["Album", 15000]]);
    // Running totals, month by month, from the first expense.
    const at = (m: string) => n.monthly.find((x) => x.month === m)!;
    expect(at("2026-01")).toEqual({ month: "2026-01", spent: 20000, madeBack: 0 });
    expect(at("2026-03")).toEqual({ month: "2026-03", spent: 25000, madeBack: 10000 });
    expect(at("2026-05")).toEqual({ month: "2026-05", spent: 25000, madeBack: 15000 });
  });

  it("pays an expense back from the project's releases only, after the label's cut", async () => {
    const { orgId, member, project } = await setup();
    // Paid by the label; paid back from the project's (the album's) sales, not the single's.
    await expense(orgId, { projectId: project.id, amountCents: 9000, recoup: true, recoupFrom: "2026-01-15" });
    const { results, saleById } = await data.computeAllTime(orgId);
    const byKey = (k: string) => results.find((r) => saleById.get(r.saleId)!.dedupeKey === k)!;
    // March album sale: $100 → $80 after the cut → $80 of the $90 goes back to the label.
    expect(byKey("a1").shares).toEqual([{ personId: member.id, cents: 0, exact: 0 }]);
    // May: the remaining $10 back, then $30 to the member.
    expect(byKey("a2").shares[0].cents).toBe(3000);
    // The single isn't part of the project: untouched.
    expect(byKey("s1").shares[0].cents).toBe(2400);
    const n = (await projects.projectNumbers(orgId)).get(project.id)!;
    expect(n.recouped).toBe(9000);
    expect(n.labelKept).toBe(3000 + 9000);
  });
});
