import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// A throwaway database for these tests; must be set before the db module loads.
process.env.LABEL_DB = join(mkdtempSync(join(tmpdir(), "label-payouts-funds-")), "test.db");

let db: typeof import("@/db").db;
let schema: typeof import("@/db").schema;
let data: typeof import("../data");

beforeAll(async () => {
  ({ db, schema } = await import("@/db"));
  data = await import("../data");
});

describe("label funds", () => {
  it("tracks a fundraiser: all of a release's money kept by the label, then sent on", () => {
    const { bands, people, releases, deductions, splitRules, splitShares, imports, sales, labelTransfers } = schema;
    const band = db.insert(bands).values({ name: "Flag Day" }).returning().get();
    const member = db.insert(people).values({ name: "Member" }).returning().get();
    const rule = db.insert(splitRules).values({ scope: "band_default", bandId: band.id }).returning().get();
    db.insert(splitShares).values({ ruleId: rule.id, personId: member.id, bps: 10000 }).run();
    const benefit = db.insert(releases).values({ bandId: band.id, title: "Benefit EP" }).returning().get();
    const album = db.insert(releases).values({ bandId: band.id, title: "Album" }).returning().get();
    // The label's usual 20% cut, and the fundraiser: everything from the benefit release goes to the label.
    db.insert(deductions).values({ label: "Label cut", kind: "percent", percentBps: 2000, destination: "label" }).run();
    db.insert(deductions).values({ label: "Fundraiser", kind: "percent", percentBps: 10000, destination: "label", releaseId: benefit.id, sortOrder: -1 }).run();
    const imp = db.insert(imports).values({ filename: "t", rowCount: 2, addedCount: 2, duplicateCount: 0 }).returning().get();
    const sale = (key: string, releaseId: number, netCents: number) =>
      db
        .insert(sales)
        .values({
          importId: imp.id, dedupeKey: key, date: "2026-03-01", itemType: "album", category: "album", itemName: key, artist: "",
          itemUrl: "", packageName: "", currency: "USD", netCents, transactionId: key, routingKey: key, bandId: band.id, releaseId, raw: {},
        })
        .run();
    sale("benefit", benefit.id, 10000);
    sale("album", album.id, 1000);

    db.insert(labelTransfers).values({ date: "2026-04-01", recipient: "Aid group", currency: "USD", amountCents: 6000, bandId: band.id, releaseId: benefit.id }).run();

    const funds = data.labelFunds();
    expect(funds.kept.get("USD")).toBe(10000 + 200); // all of the benefit, 20% of the album
    expect(funds.sent.get("USD")).toBe(6000);
    expect(funds.balance.get("USD")).toBe(4200);
    expect(funds.causes).toHaveLength(1);
    expect(funds.causes[0]).toMatchObject({ releaseId: benefit.id });
    expect(funds.causes[0].raised.get("USD")).toBe(10000); // what the benefit release raised
    expect(funds.causes[0].sent.get("USD")).toBe(6000); // 40.00 still to send on
  });
});
