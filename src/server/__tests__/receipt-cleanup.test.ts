import { beforeAll, describe, expect, it } from "vitest";
import { newAccount, testDb } from "../../../test/helpers/db";

process.env.APP_ENCRYPTION_KEY ??= "test-key";

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let cleanup: typeof import("../receipt-cleanup");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  cleanup = await import("../receipt-cleanup");
});

describe("clearing out settled receipts' files", () => {
  it("offers only the files of settled receipts, oldest first", async () => {
    const orgId = await newAccount();
    const [person] = await db.insert(schema.people).values({ orgId, name: "Fronted it" }).returning();
    const add = async (date: string, o: Partial<typeof schema.expenses.$inferInsert>) => {
      const [x] = await db
        .insert(schema.expenses)
        .values({ orgId, date, description: date, amountCents: 500, paidBy: "label", status: "approved", ...o })
        .returning();
      await db.insert(schema.expenseFiles).values({ orgId, expenseId: x.id, filename: `${date}.jpg`, contentType: "image/jpeg", size: 10, data: new Uint8Array([1]) });
      return x;
    };
    await add("2026-03-01", {}); // label paid, nothing to pay back: settled
    await add("2026-01-01", { paidBy: "person", paidByPersonId: person.id, reimbursedAt: "2026-02-01" }); // paid back: settled
    await add("2026-02-01", { paidBy: "person", paidByPersonId: person.id }); // still owed
    await add("2026-02-02", { status: "pending" });
    await add("2026-02-03", { recoup: true }); // no sales yet to pay it back
    const { files, receipts, batches } = await cleanup.clearableFiles(orgId);
    expect(files.map((f) => f.date)).toEqual(["2026-01-01", "2026-03-01"]);
    expect(receipts).toBe(2);
    expect(batches).toHaveLength(1);
    // Asking for a specific file only returns it if it's settled.
    const owed = (await db.select().from(schema.expenseFiles)).find((f) => f.filename === "2026-02-01.jpg")!;
    expect((await cleanup.clearableFiles(orgId, [owed.id])).files).toEqual([]);
  });
});
