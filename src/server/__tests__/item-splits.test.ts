import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { newAccount, testDb } from "../../../test/helpers/db";

// A band account the label made, looking at the label's books for its band (the lens).
let labelOrgId = "";
let ownOrgId = "";
let bandId = 0;
let ownCanSplit = true;
const admin = { admin: true, permissions: {}, bandAreas: [], bandIds: [] };
const lens = () => ({
  orgId: labelOrgId,
  lens: true,
  managedBy: { linkId: 1, labelOrgId, labelName: "Label", bandId, ownBooks: true },
  access: { admin: false, permissions: { catalog: "edit" }, bandAreas: ["catalog"], bandIds: [bandId] },
});
const own = () => ({ orgId: ownOrgId, lens: false, books: "own", access: ownCanSplit ? admin : { admin: false, permissions: {}, bandAreas: [], bandIds: [] } });
vi.mock("../context", () => ({
  getContext: async () => lens(),
  ownBooksOf: async () => own(),
  requireAccess: async () => own(),
  requireAdmin: async () => own(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error("not found");
  },
}));

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let actions: typeof import("../actions");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  actions = await import("../actions");
});

const form = (values: Record<string, string | number>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, String(v));
  return fd;
};

describe("a band account's splits on its own items", () => {
  it("go in the label's books for its band's items, and nowhere else", async () => {
    labelOrgId = await newAccount("Label");
    ownOrgId = await newAccount("Flag Day", "band");
    const [band] = await db.insert(schema.bands).values({ orgId: labelOrgId, name: "Flag Day" }).returning();
    const [other] = await db.insert(schema.bands).values({ orgId: labelOrgId, name: "Someone Else" }).returning();
    bandId = band.id;
    const [cd] = await db.insert(schema.releases).values({ orgId: labelOrgId, bandId: band.id, title: "Flags of the World" }).returning();
    const [theirs] = await db.insert(schema.releases).values({ orgId: labelOrgId, bandId: other.id, title: "Not Theirs" }).returning();
    const [person] = await db.insert(schema.people).values({ orgId: labelOrgId, name: "Alex" }).returning();
    const shares = JSON.stringify([{ personId: person.id, bps: 10000 }]);

    expect(await actions.saveSplitRule(null, form({ scope: "release", releaseId: cd.id, shares }))).toEqual({ ok: "Split saved" });
    const [rule] = await db.select().from(schema.splitRules).where(eq(schema.splitRules.releaseId, cd.id));
    expect(rule.orgId).toBe(labelOrgId);

    expect(await actions.saveSplitRule(null, form({ scope: "release", releaseId: theirs.id, shares }))).toEqual({ error: "That item isn’t your band’s." });

    // Taken off again from the band account.
    await actions.deleteSplitRule(form({ ruleId: rule.id }));
    expect(await db.select().from(schema.splitRules).where(eq(schema.splitRules.releaseId, cd.id))).toEqual([]);

    // Only if it can change its own splits.
    ownCanSplit = false;
    await expect(actions.saveSplitRule(null, form({ scope: "release", releaseId: cd.id, shares }))).rejects.toThrow("redirect /me");
    ownCanSplit = true;
  });
});
