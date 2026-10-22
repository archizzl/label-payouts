import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { type Access, can } from "@/lib/permissions";
import { newAccount, testDb } from "../../../test/helpers/db";
import type { Context } from "../context";

/*
 * Abel (src/server/abel): it's given only the tools the person may use, they keep to the person's
 * bands, changes wait for a confirmation, and chats stay with the account and person they're in.
 */

const ADMIN: Access = { admin: true, permissions: {}, bandAreas: [], bandIds: [] };
let who = {} as Context;
const as = (orgId: string, userId: string, access: Access, extra: Partial<Context> = {}) => {
  who = {
    user: { id: userId, name: "Tester", email: `${userId}@example.test` },
    org: { id: orgId, name: "Test Label", slug: "t", kind: "label", role: access.admin ? "admin" : "member" },
    orgId,
    role: access.admin ? "admin" : "member",
    isAdmin: access.admin,
    access,
    memberType: null,
    person: null,
    accounts: [],
    managedBy: null,
    viewingAs: null,
    lens: false,
    ...extra,
  };
};
const contextFor = async (area: Parameters<typeof can>[1], level: "view" | "edit" = "view") => (can(who.access, area, level) ? who : null);
vi.mock("../context", () => ({
  getContext: async () => who,
  accountContext: async () => who,
  ownBooksOf: async () => who,
  contextFor,
  requireAccess: async (area: Parameters<typeof can>[1], level: "view" | "edit" = "view") => {
    const ctx = await contextFor(area, level);
    if (!ctx) (await import("next/navigation")).redirect("/me");
    return ctx;
  },
  requireAdmin: async () => who,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let tool: typeof import("../abel/tool");
let agent: typeof import("../abel/agent");
let sessions: typeof import("../abel/session-service");
let adk: typeof import("../abel/adk");

beforeAll(async () => {
  ({ db, schema } = await testDb());
  tool = await import("../abel/tool");
  agent = await import("../abel/agent");
  sessions = await import("../abel/session-service");
  adk = await import("../abel/adk");
});

async function newUser() {
  const id = `u-${Math.random().toString(36).slice(2)}`;
  await db.insert(schema.user).values({ id, name: "Tester", email: `${id}@example.test`, emailVerified: false, createdAt: new Date(), updatedAt: new Date() });
  return id;
}

/** Two bands with a split each, and a $10 sale each in January. */
async function setup() {
  const orgId = await newAccount();
  const userId = await newUser();
  const [a] = await db.insert(schema.bands).values({ orgId, name: "Band A" }).returning();
  const [b] = await db.insert(schema.bands).values({ orgId, name: "Band B" }).returning();
  const [p] = await db.insert(schema.people).values({ orgId, name: "A member" }).returning();
  for (const band of [a, b]) {
    const [rule] = await db.insert(schema.splitRules).values({ orgId, scope: "band_default", bandId: band.id }).returning();
    await db.insert(schema.splitShares).values({ orgId, ruleId: rule.id, personId: p.id, bps: 10000 });
  }
  const [imp] = await db.insert(schema.imports).values({ orgId, filename: "t", rowCount: 2, addedCount: 2, duplicateCount: 0 }).returning();
  for (const band of [a, b]) {
    const key = `${band.name}-1`;
    await db.insert(schema.sales).values({
      orgId,
      importId: imp.id,
      dedupeKey: key,
      date: "2026-01-10",
      itemType: "album",
      category: "album",
      itemName: `${band.name} album`,
      artist: band.name,
      itemUrl: "",
      packageName: "",
      currency: "USD",
      netCents: 1000,
      transactionId: key,
      routingKey: key,
      bandId: band.id,
      raw: {},
    });
  }
  return { orgId, userId, a, b, p };
}

const names = async () => (await tool.toolsFor(who, agent.ABEL_TOOLS, null)).map((t) => t.name).sort();
const find = (name: string) => agent.ABEL_TOOLS.find((t) => t.name === name)!;
const run = async (name: string, args: Record<string, unknown>) => {
  const t = find(name);
  const ctx = await tool.toolContext(who, t);
  return ctx ? t.run(ctx, t.params.parse(args)) : "not allowed";
};

describe("Abel's tools", () => {
  it("gives an admin every tool", async () => {
    const { orgId, userId } = await setup();
    as(orgId, userId, ADMIN);
    expect(await names()).toEqual(agent.ABEL_TOOLS.filter((t) => t.name !== "my_earnings").map((t) => t.name).sort());
  });

  it("gives a member with no member type only their own things", async () => {
    const { orgId, userId, p } = await setup();
    as(orgId, userId, { admin: false, permissions: {}, bandAreas: [], bandIds: [] }, { person: p });
    expect(await names()).toEqual(["add_manual_sale", "my_access", "my_earnings", "where_is"]);
  });

  it("gives no changes to someone viewing as another person", async () => {
    const { orgId, userId } = await setup();
    as(orgId, userId, ADMIN, { viewingAs: { kind: "person", name: "Someone", label: who.org, realUser: who.user, back: "/" } });
    const writes = agent.ABEL_TOOLS.filter((t) => t.write).map((t) => t.name);
    expect((await names()).filter((n) => writes.includes(n))).toEqual([]);
    expect(await tool.toolContext(who, find("create_payout"))).toBeNull();
  });

  it("lets someone who can view payouts look, not finalize", async () => {
    const { orgId, userId } = await setup();
    as(orgId, userId, { admin: false, permissions: { payouts: "view" }, bandAreas: [], bandIds: [] });
    const got = await names();
    expect(got).toContain("list_payouts");
    expect(got).not.toContain("create_payout");
    expect(await run("create_payout", { from: "2026-01-01", to: "2026-01-31" })).toBe("not allowed");
  });

  it("keeps sales to the person's own bands", async () => {
    const { orgId, userId, a, b } = await setup();
    as(orgId, userId, { admin: false, permissions: { sales: "view" }, bandAreas: ["sales"], bandIds: [a.id] });
    const mine = (await run("sales_summary", {})) as { totals: { sales: number }[]; byBand: string[] };
    expect(mine.totals[0].sales).toBe(1);
    expect(mine.byBand.join()).toContain("Band A");
    expect(mine.byBand.join()).not.toContain("Band B");
    expect(await run("sales_summary", { bandId: b.id })).toEqual({ error: "That isn't one of your bands." });
  });

  it("makes a change through the app's own action", async () => {
    const { orgId, userId, a } = await setup();
    as(orgId, userId, ADMIN);
    const done = (await run("create_payout", { from: "2026-01-01", to: "2026-01-31", bandId: a.id })) as { ok: string; link: string };
    expect(done.ok).toBe("Payout finalized.");
    expect(done.link).toMatch(/^\/periods\/\d+$/);
    const periods = await db.select().from(schema.periods).where(eq(schema.periods.orgId, orgId));
    expect(periods.map((p) => p.bandId)).toEqual([a.id]);
  });
});

describe("Abel's chats", () => {
  it("are only found in their own account, by the person who started them", async () => {
    const { orgId, userId } = await setup();
    const other = await newAccount();
    const service = new sessions.DrizzleSessionService(orgId);
    const chat = await service.createSession({ appName: sessions.APP_NAME, userId });
    const key = { appName: sessions.APP_NAME, sessionId: chat.id };
    expect(await service.getSession({ ...key, userId })).toBeDefined();
    expect(await service.getSession({ ...key, userId: await newUser() })).toBeUndefined();
    expect(await new sessions.DrizzleSessionService(other).getSession({ ...key, userId })).toBeUndefined();
  });

  it("ask before a change, and make it once it's confirmed", async () => {
    const { orgId, userId } = await setup();
    as(orgId, userId, ADMIN);
    // A stand-in for Gemini: asks to finalize January's payout, then says what happened.
    class Stub extends adk.BaseLlm {
      constructor() {
        super({ model: "stub" });
      }
      async *generateContentAsync(req: { contents: { parts?: { functionResponse?: { response?: unknown } }[] }[] }) {
        const response = req.contents.at(-1)?.parts?.find((p) => p.functionResponse)?.functionResponse?.response;
        if (response) yield { content: { role: "model", parts: [{ text: `Result: ${JSON.stringify(response)}` }] } };
        else yield { content: { role: "model", parts: [{ functionCall: { id: "call-1", name: "create_payout", args: { from: "2026-01-01", to: "2026-01-31" } } }] } };
      }
      async connect(): Promise<never> {
        throw new Error("not used");
      }
    }
    const service = new sessions.DrizzleSessionService(orgId);
    const chat = await service.createSession({ appName: sessions.APP_NAME, userId });
    const runTurn = async (newMessage: import("../abel/adk").Content) => {
      // A fresh agent and runner each time, as each request makes: the chat comes back from the database.
      const runner = new adk.Runner({ appName: sessions.APP_NAME, agent: await agent.abelFor(who, Number(chat.id), new Stub()), sessionService: service });
      const events = [];
      for await (const e of runner.runAsync({ userId, sessionId: chat.id, newMessage })) events.push(e);
      return events;
    };

    const asked = await runTurn({ role: "user", parts: [{ text: "Pay out January" }] });
    const request = asked.flatMap((e) => adk.getFunctionCalls(e)).find((c) => c.name === adk.REQUEST_CONFIRMATION_FUNCTION_CALL_NAME)!;
    expect(request).toBeDefined();
    expect(await db.select().from(schema.periods).where(eq(schema.periods.orgId, orgId))).toEqual([]);

    const answered = await runTurn({
      role: "user",
      parts: [{ functionResponse: { id: request.id, name: adk.REQUEST_CONFIRMATION_FUNCTION_CALL_NAME, response: { confirmed: true } } }],
    });
    expect(answered.at(-1)?.content?.parts?.[0]?.text).toContain("Payout finalized.");
    expect(await db.select().from(schema.periods).where(eq(schema.periods.orgId, orgId))).toHaveLength(1);
    const [action] = await db.select().from(schema.abelActions).where(eq(schema.abelActions.orgId, orgId));
    expect(action).toMatchObject({ tool: "create_payout", status: "done", userId });

    // Shown again: the question, then the confirmed change.
    const { toMessages } = await import("../abel/messages");
    const shown = await toMessages(who, (await sessions.chatEvents(orgId, userId, Number(chat.id)))!.events);
    expect(shown[0]).toEqual({ kind: "user", text: "Pay out January" });
    expect(shown.find((m) => m.kind === "confirm")).toMatchObject({ answer: "confirmed" });
    expect(await agent.overDailyLimit(userId)).toBe(false);
  });
});

describe("Abel's confirmations", () => {
  it("are each answered once", async () => {
    const { awaitingAnswer } = await import("../abel/messages");
    const ask = { author: "abel", content: { parts: [{ functionCall: { id: "q1", name: adk.REQUEST_CONFIRMATION_FUNCTION_CALL_NAME, args: {} } }] } };
    const answer = { author: "user", content: { parts: [{ functionResponse: { id: "q1", name: adk.REQUEST_CONFIRMATION_FUNCTION_CALL_NAME, response: { confirmed: false } } }] } };
    const events = (list: object[]) => list as import("../abel/adk").Event[];
    expect(awaitingAnswer(events([ask]), "q1")).toBe(true);
    expect(awaitingAnswer(events([ask, answer]), "q1")).toBe(false);
    expect(awaitingAnswer(events([ask]), "other")).toBe(false);
    // Only Abel can ask: a "request" the person sent themselves doesn't count.
    expect(awaitingAnswer(events([{ ...ask, author: "user" }]), "q1")).toBe(false);
  });
});
