import { beforeAll, describe, expect, it } from "vitest";
import { newAccount, testDb } from "../../../test/helpers/db";

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let data: typeof import("../data");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  data = await import("../data");
});

describe("label funds", () => {
  it("tracks a fundraiser: all of a release's money kept by the label, then sent on", async () => {
    const orgId = await newAccount();
    const { bands, people, releases, deductions, splitRules, splitShares, imports, sales, labelTransfers } = schema;
    const [band] = await db.insert(bands).values({ orgId, name: "Flag Day" }).returning();
    const [member] = await db.insert(people).values({ orgId, name: "Member" }).returning();
    const [rule] = await db.insert(splitRules).values({ orgId, scope: "band_default", bandId: band.id }).returning();
    await db.insert(splitShares).values({ orgId, ruleId: rule.id, personId: member.id, bps: 10000 });
    const [benefit] = await db.insert(releases).values({ orgId, bandId: band.id, title: "Benefit EP" }).returning();
    const [album] = await db.insert(releases).values({ orgId, bandId: band.id, title: "Album" }).returning();
    // The label's usual 20% cut, and the fundraiser: everything from the benefit release goes to the label.
    await db.insert(deductions).values({ orgId, label: "Label cut", kind: "percent", percentBps: 2000, destination: "label" });
    await db
      .insert(deductions)
      .values({ orgId, label: "Fundraiser", kind: "percent", percentBps: 10000, destination: "label", releaseId: benefit.id, sortOrder: -1 });
    const [imp] = await db.insert(imports).values({ orgId, filename: "t", rowCount: 2, addedCount: 2, duplicateCount: 0 }).returning();
    const sale = (key: string, releaseId: number, netCents: number) =>
      db.insert(sales).values({
        orgId, importId: imp.id, dedupeKey: key, date: "2026-03-01", itemType: "album", category: "album", itemName: key, artist: "",
        itemUrl: "", packageName: "", currency: "USD", netCents, transactionId: key, routingKey: key, bandId: band.id, releaseId, raw: {},
      });
    await sale("benefit", benefit.id, 10000);
    await sale("album", album.id, 1000);

    await db
      .insert(labelTransfers)
      .values({ orgId, date: "2026-04-01", recipient: "Aid group", currency: "USD", amountCents: 6000, bandId: band.id, releaseId: benefit.id });

    const funds = await data.labelFunds(orgId);
    expect(funds.kept.get("USD")).toBe(10000 + 200); // all of the benefit, 20% of the album
    expect(funds.sent.get("USD")).toBe(6000);
    expect(funds.balance.get("USD")).toBe(4200);
    expect(funds.causes).toHaveLength(1);
    expect(funds.causes[0]).toMatchObject({ releaseId: benefit.id });
    expect(funds.causes[0].raised.get("USD")).toBe(10000); // what the benefit release raised
    expect(funds.causes[0].sent.get("USD")).toBe(6000); // 40.00 still to send on
  });

  it("measures a send-out tied to a source against that source only, not the label's other money from the release", async () => {
    const orgId = await newAccount();
    const { bands, people, releases, deductions, splitRules, splitShares, imports, sales, labelTransfers } = schema;
    const [band] = await db.insert(bands).values({ orgId, name: "Flag Day" }).returning();
    const [member] = await db.insert(people).values({ orgId, name: "Member" }).returning();
    const [rule] = await db.insert(splitRules).values({ orgId, scope: "band_default", bandId: band.id }).returning();
    await db.insert(splitShares).values({ orgId, ruleId: rule.id, personId: member.id, bps: 10000 });
    const [single] = await db.insert(releases).values({ orgId, bandId: band.id, title: "Triple Single" }).returning();
    // The CD's manufacturing cost comes off first, then the fundraiser takes the rest.
    await db.insert(deductions).values([
      { orgId, label: "CD costs", kind: "per_unit", amountCents: 400, currency: "USD", destination: "label", itemCategory: "merch", sortOrder: -2 },
      { orgId, label: "Fundraiser", kind: "percent", percentBps: 10000, destination: "label", releaseId: single.id, sortOrder: -1 },
    ]);
    const [imp] = await db.insert(imports).values({ orgId, filename: "t", rowCount: 1, addedCount: 1, duplicateCount: 0 }).returning();
    await db.insert(sales).values({
      orgId, importId: imp.id, dedupeKey: "cd", date: "2026-03-01", itemType: "package", category: "merch", itemName: "Triple Single", artist: "",
      itemUrl: "", packageName: "CD", currency: "USD", netCents: 1000, transactionId: "cd", routingKey: "cd", bandId: band.id, releaseId: single.id, raw: {},
    });
    await db.insert(labelTransfers).values({
      orgId, date: "2026-04-01", recipient: "Aid group", currency: "USD", amountCents: 600, bandId: band.id, releaseId: single.id, source: "Fundraiser",
    });
    const funds = await data.labelFunds(orgId);
    expect(funds.kept.get("USD")).toBe(1000); // $4 CD costs + $6 fundraiser
    expect(funds.causes[0].raised.get("USD")).toBe(600); // just the fundraiser: all of it sent
    expect(funds.causes[0].sent.get("USD")).toBe(600);
  });
});
