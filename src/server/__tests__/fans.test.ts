import { beforeAll, describe, expect, it } from "vitest";
import { newAccount, testDb } from "../../../test/helpers/db";
import { parseFanCsv } from "@/lib/fan-csv";

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let fans: typeof import("../fans");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  fans = await import("../fans");
});

describe("the mailing list", () => {
  it("imports fans onto band lists, matches them by email on re-import, and keeps accounts apart", async () => {
    const orgId = await newAccount();
    const [flagDay] = await db.insert(schema.bands).values({ orgId, name: "Flag Day" }).returning();
    const [sweetums] = await db.insert(schema.bands).values({ orgId, name: "Sweetums", aliases: ["The Sweetums"] }).returning();

    const first = parseFanCsv("email,artist,date added,country\nann@example.com,Flag Day,2024-05-01,US\nbob@example.com,The Sweetums,2024-06-01,\ncat@example.com,Someone Else,2024-07-01,UK\n");
    const plan = await fans.planFanImport(orgId, first.fans);
    expect(plan).toMatchObject({ total: 3, fresh: 3, known: 0, dateRange: ["2024-05-01", "2024-07-01"] });
    expect(plan.sources.find((s) => s.name === "Someone Else")?.bandId).toBeNull();
    // Fans of artists with no matching band go on the list the admin picked (here: Flag Day's).
    expect(await fans.importFans(orgId, first.fans, { filename: "a.csv", bandId: flagDay.id, userId: null })).toMatchObject({ added: 3, updated: 0 });

    // Again, with Bob now on Flag Day's list too, an earlier date for Ann and Bob's country.
    const second = parseFanCsv("email,artist,date added,country\nANN@example.com,Flag Day,2023-01-01,\nbob@example.com,Flag Day,2024-06-01,Canada\n");
    expect((await fans.planFanImport(orgId, second.fans)).known).toBe(2);
    expect(await fans.importFans(orgId, second.fans, { filename: "b.csv", bandId: null, userId: null })).toMatchObject({ added: 0, updated: 2 });

    const all = await fans.listFans(orgId, {});
    expect(all.count).toBe(3);
    const by = Object.fromEntries(all.rows.map((f) => [f.email, f]));
    expect(by["ann@example.com"]).toMatchObject({ addedOn: "2023-01-01", country: "US", bandIds: [flagDay.id] });
    expect(by["bob@example.com"].country).toBe("Canada");
    expect(by["bob@example.com"].bandIds.sort()).toEqual([flagDay.id, sweetums.id].sort());
    expect(by["cat@example.com"].bandIds).toEqual([flagDay.id]);

    expect((await fans.listFans(orgId, { bandId: sweetums.id })).rows.map((f) => f.email)).toEqual(["bob@example.com"]);
    expect((await fans.listFans(orgId, { q: "canada" })).count).toBe(1);
    expect((await fans.listFans(orgId, { q: "100%" })).count).toBe(0);

    const stats = await fans.fanStats(orgId);
    expect(stats.total).toBe(3);
    expect(stats.byBand.find((b) => b.bandId === flagDay.id)?.n).toBe(3);
    // Sign-ups month by month per band and country, for trend lines.
    expect(stats.bandMonths.filter((r) => r.bandId === flagDay.id).map((r) => [r.month, r.n]).sort()).toEqual([
      ["2023-01", 1],
      ["2024-06", 1],
      ["2024-07", 1],
    ]);
    expect(stats.countryMonths.find((r) => r.country === "Canada")).toMatchObject({ month: "2024-06", n: 1 });

    // Another account sees none of them.
    expect((await fans.listFans(await newAccount(), {})).count).toBe(0);
  });

  it("puts fans on the label's own list when no band is given", async () => {
    const orgId = await newAccount();
    await fans.importFans(orgId, parseFanCsv("dee@example.com\n").fans, { filename: "c.csv", bandId: null, userId: null });
    expect((await fans.listFans(orgId, { bandId: "label" })).rows.map((f) => f.email)).toEqual(["dee@example.com"]);
  });
});
