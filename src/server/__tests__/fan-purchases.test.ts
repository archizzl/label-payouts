import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { newAccount, testDb } from "../../../test/helpers/db";
import { parseBandcampCsv } from "@/lib/bandcamp-csv";
import { parseFanCsv } from "@/lib/fan-csv";

process.env.APP_ENCRYPTION_KEY ??= "test-key";

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let fans: typeof import("../fans");
let sync: typeof import("../sync");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  fans = await import("../fans");
  sync = await import("../sync");
});

const report = (rows: string[]) =>
  parseBandcampCsv(["date,item type,item name,artist,buyer name,buyer email,currency,net amount,bandcamp transaction id", ...rows].join("\n"));

describe("fans and what they bought", () => {
  it("matches fans to their purchases by email, without storing buyers' emails", async () => {
    const orgId = await newAccount();
    await sync.saveSales(
      orgId,
      "report.csv",
      report([
        "2026-03-01,album,LP,Flag Day,Ann Lee,Ann@Example.com,USD,9.00,t1",
        "2026-03-05,track,Single,Flag Day,Ann Lee,ann@example.com,USD,1.00,t2",
        "2026-03-06,album,LP,Flag Day,Zed,zed@example.com,USD,9.00,t3",
        "2026-03-07,album,LP,Flag Day,,,USD,9.00,t4",
      ]),
    );
    const stored = await db.select().from(schema.sales).where(eq(schema.sales.orgId, orgId));
    expect(JSON.stringify(stored)).not.toMatch(/example\.com/i); // no buyer email anywhere
    expect(stored.find((s) => s.transactionId === "t4")?.buyerKey).toBe(""); // checked, no email

    await fans.importFans(orgId, parseFanCsv("email\nann@example.com\nbob@example.com\n").fans, { filename: "list.csv", bandId: null, userId: null });
    const { rows } = await fans.listFans(orgId, {});
    const ann = rows.find((f) => f.email === "ann@example.com")!;
    expect(ann.purchases.map((p) => p.itemName)).toEqual(["Single", "LP"]); // newest first
    expect(rows.find((f) => f.email === "bob@example.com")!.purchases).toEqual([]);

    const stats = await fans.fanStats(orgId);
    expect(stats.buyers).toEqual({ known: 2, onList: 1, unchecked: 0 }); // Ann and Zed bought; Ann's on the list
    expect(stats.top).toEqual([expect.objectContaining({ email: "ann@example.com", cents: 1000, items: 2 })]);
  });

  it("fills in buyers for sales imported before, the next time the same report comes in", async () => {
    const orgId = await newAccount();
    await sync.saveSales(orgId, "old.csv", report(["2026-03-01,album,LP,Flag Day,Ann,ann@example.com,USD,9.00,t1"]));
    await db.update(schema.sales).set({ buyerKey: null }).where(eq(schema.sales.orgId, orgId)); // as if imported before this existed
    const again = await sync.saveSales(orgId, "sync", report(["2026-03-01,album,LP,Flag Day,Ann,ann@example.com,USD,9.00,t1"]));
    expect(again.added).toBe(0);
    await fans.importFans(orgId, parseFanCsv("email\nann@example.com\n").fans, { filename: "list.csv", bandId: null, userId: null });
    expect((await fans.listFans(orgId, {})).rows[0].purchases).toHaveLength(1);
  });

  it("keeps accounts apart", async () => {
    const a = await newAccount();
    const b = await newAccount();
    await sync.saveSales(a, "r.csv", report(["2026-03-01,album,LP,X,Ann,ann@example.com,USD,9.00,t1"]));
    await fans.importFans(b, parseFanCsv("email\nann@example.com\n").fans, { filename: "list.csv", bandId: null, userId: null });
    expect((await fans.listFans(b, {})).rows[0].purchases).toEqual([]);
  });
});
