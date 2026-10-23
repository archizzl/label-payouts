import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { type Access, can } from "@/lib/permissions";
import type { Context } from "../../context";

/*
 * Abel's conversations, with the real AI service, about the local data (`npm run dev`'s database):
 * `npm run abel:eval` (or `-- -t "young jethros"` for one). For seeing what he's good and bad at
 * after changing his tools or instructions; it doesn't pass or fail on its own.
 *
 * Safe on real data: the database is opened read-only, a change he asks for is recorded (with its
 * confirm card) but never confirmed, and chats are kept in memory. He talks as the owner of the
 * label with the most sales. Transcripts go to ABEL_EVAL_OUT (default .abel-eval.md, git-ignored).
 */

// The AI service's key and the app's local settings (Bandcamp's API stays off), from .env.development.local.
for (const line of readFileSync(".env.development.local", "utf8").split("\n")) {
  const m = /^(GEMINI_API_KEY|DEEPSEEK_API_KEY|OPENROUTER_API_KEY|ABEL_PROVIDER|ABEL_MODEL|APP_ENCRYPTION_KEY|BANDCAMP_API)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
}
process.env.DATABASE_URL = "postgres://postgres:local@127.0.0.1:5433/label_payouts?options=-c%20default_transaction_read_only%3Don";

const ADMIN: Access = { admin: true, permissions: {}, bandAreas: [], bandIds: [] };
let who = {} as Context;
const contextFor = async (area: Parameters<typeof can>[1], level: "view" | "edit" = "view") => (can(who.access, area, level) ? who : null);
vi.mock("../../context", () => ({
  getContext: async () => who,
  accountContext: async () => who,
  ownBooksOf: async () => who,
  contextFor,
  requireAccess: async () => who,
  requireAdmin: async () => who,
}));

type Turn = { say: string };
type Case = { name: string; turns: Turn[] };

/** What people ask. Each is a fresh chat; later turns follow on. */
const CASES: Case[] = [
  { name: "young jethros deduction", turns: [{ say: "please create a 100% label deduction for the young jethros" }] },
  { name: "how many artists", turns: [{ say: "how many artists does my label have" }] },
  { name: "band earnings last month", turns: [{ say: "what did sweetums make last month?" }] },
  { name: "who is owed", turns: [{ say: "who is owed money right now?" }] },
  { name: "best seller", turns: [{ say: "what's our best selling release?" }] },
  { name: "even split", turns: [{ say: "set flag day's split to even between its members" }] },
  { name: "label kept", turns: [{ say: "how much has the label kept in total?" }] },
  { name: "label balance", turns: [{ say: "how much money does the label have?" }, { say: "are you sure it's 50.60 and not 94.85?" }] },
  { name: "tracks of an album", turns: [{ say: "what tracks are on the young jethros?" }] },
  { name: "deductions for a band", turns: [{ say: "what deductions apply to flag day?" }] },
  { name: "add a show", turns: [{ say: "record a $200 show for alex klint last friday" }] },
  { name: "year over year", turns: [{ say: "how did sales do this year compared to last year?" }] },
  { name: "payout", turns: [{ say: "pay everyone out for september" }] },
  { name: "change label cut", turns: [{ say: "change the label cut to 20%" }] },
  { name: "band members", turns: [{ say: "who's in pheasant bibulous?" }] },
  { name: "unmatched", turns: [{ say: "are there any sales that didn't match a band?" }] },
  { name: "invite", turns: [{ say: "invite sam@example.com to sign in as an admin" }] },
  { name: "orders", turns: [{ say: "which orders need shipping?" }] },
  { name: "typo", turns: [{ say: "how much did flagday earn in total" }] },
  { name: "person details", turns: [{ say: "what's noah salinger's email?" }] },
  { name: "release earnings", turns: [{ say: "how much has the young jethros made?" }] },
  { name: "follow-up", turns: [{ say: "what are sweetums' releases?" }, { say: "add a $3 per copy cost to the first one, withheld" }] },
  { name: "partial name", turns: [{ say: "how has the ank done?" }] },
  { name: "delete by name", turns: [{ say: "delete the cd costs deduction" }] },
  { name: "split for a release", turns: [{ say: "give archie 100% of triple single" }] },
  { name: "who can sign in", turns: [{ say: "who can sign in to the label?" }] },
  { name: "can't do", turns: [{ say: "import this bandcamp csv for me" }] },
  { name: "band or person", turns: [{ say: "can you add a new t shirt inventory item for alex klint please" }] },
  { name: "person not band", turns: [{ say: "what's alex klint's paypal?" }] },
  { name: "top fans", turns: [{ say: "please rank the top 5 flag day fans by spend" }, { say: "ok -- rank the top flag day items by sales" }] },
];

const out: string[] = [];
/** Tokens per conversation: model calls, prompt (and how much of it came from the service's cache), reply. */
type Tokens = { calls: number; input: number; cached: number; output: number };
const tokens: (Tokens & { name: string })[] = [];
const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "–");
let adk: typeof import("../adk");
let agent: typeof import("../agent");
let tool: typeof import("../tool");

beforeAll(async () => {
  const { db, schema } = await import("@/db");
  const { desc, eq, sql } = await import("drizzle-orm");
  adk = await import("../adk");
  agent = await import("../agent");
  tool = await import("../tool");
  // The label with the most sales, and its owner.
  const [org] = await db
    .select({ id: schema.organization.id, name: schema.organization.name, slug: schema.organization.slug })
    .from(schema.organization)
    .where(eq(schema.organization.kind, "label"))
    .orderBy(desc(sql`(select count(*) from sales s where s.org_id = ${schema.organization.id})`))
    .limit(1);
  const [owner] = await db
    .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(eq(schema.member.organizationId, org.id))
    .orderBy(sql`case ${schema.member.role} when 'owner' then 0 when 'admin' then 1 else 2 end`)
    .limit(1);
  const [person] = await db.select().from(schema.people).where(eq(schema.people.userId, owner.id)).limit(1);
  const account = { id: org.id, name: org.name, slug: org.slug, kind: "label" as const, role: "owner" as const };
  who = {
    user: owner,
    org: account,
    orgId: org.id,
    role: "owner",
    isAdmin: true,
    access: ADMIN,
    memberType: null,
    person: person ?? null,
    accounts: [account],
    managedBy: null,
    viewingAs: null,
    lens: false,
  };
  out.push(`# Abel conversations\n\n${new Date().toISOString()} · ${process.env.ABEL_PROVIDER ?? "first provider with a key"} ${process.env.ABEL_MODEL ?? ""} · as ${owner.name}, owner of ${org.name}\n`);
});

afterAll(() => {
  if (tokens.length) {
    const sum = tokens.reduce((a, t) => ({ calls: a.calls + t.calls, input: a.input + t.input, cached: a.cached + t.cached, output: a.output + t.output }), { calls: 0, input: 0, cached: 0, output: 0 });
    out.push(
      "\n## Tokens\n",
      "| Conversation | Model calls | Input | Cached | Output |",
      "|---|---|---|---|---|",
      ...tokens.map((t) => `| ${t.name} | ${t.calls} | ${t.input.toLocaleString()} | ${t.cached.toLocaleString()} (${pct(t.cached, t.input)}) | ${t.output.toLocaleString()} |`),
      `| **All ${tokens.length}** | ${sum.calls} | ${sum.input.toLocaleString()} | ${sum.cached.toLocaleString()} (${pct(sum.cached, sum.input)}) | ${sum.output.toLocaleString()} |`,
      `\nPer model call: ${Math.round(sum.input / Math.max(1, sum.calls)).toLocaleString()} input tokens, ${Math.round(sum.cached / Math.max(1, sum.calls)).toLocaleString()} of them cached.`,
    );
  }
  writeFileSync(process.env.ABEL_EVAL_OUT ?? ".abel-eval.md", out.join("\n"));
});

const clip = (s: string, n = 600) => (s.length > n ? `${s.slice(0, n)}… (${s.length} characters)` : s);

describe("Abel", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const sessions = new adk.InMemorySessionService();
      const session = await sessions.createSession({ appName: "abel", userId: who.user.id });
      const runner = new adk.Runner({ appName: "abel", agent: await agent.abelFor(who, null), sessionService: sessions });
      out.push(`\n## ${c.name}\n`);
      const used: Tokens = { calls: 0, input: 0, cached: 0, output: 0 };
      for (const turn of c.turns) {
        out.push(`**You:** ${turn.say}\n`);
        const started = Date.now();
        let calls = 0;
        for await (const e of runner.runAsync({
          userId: who.user.id,
          sessionId: session.id,
          newMessage: { role: "user", parts: [{ text: turn.say }] },
          runConfig: adk.createRunConfig({ maxLlmCalls: agent.MAX_LLM_CALLS }),
        })) {
          if (e.errorMessage) out.push(`> ⚠️ ${e.errorCode}: ${clip(e.errorMessage, 300)}`);
          if (!e.partial && e.usageMetadata) {
            used.calls++;
            used.input += e.usageMetadata.promptTokenCount ?? 0;
            used.cached += e.usageMetadata.cachedContentTokenCount ?? 0;
            used.output += e.usageMetadata.candidatesTokenCount ?? 0;
          }
          for (const part of e.content?.parts ?? []) {
            const call = part.functionCall;
            if (call?.name === adk.REQUEST_CONFIRMATION_FUNCTION_CALL_NAME) {
              const original = (call.args as { originalFunctionCall?: { name: string; args: unknown } }).originalFunctionCall;
              const card = original ? await tool.describeChange(who, agent.ABEL_TOOLS, original.name, original.args) : "?";
              out.push(`> 🟦 **Confirm card:** ${card}`);
            } else if (call) {
              calls++;
              out.push(`> 🔧 \`${call.name}(${JSON.stringify(call.args)})\``);
            } else if (part.functionResponse) {
              out.push(`> ↩︎ ${clip(JSON.stringify(part.functionResponse.response), 400)}`);
            } else if (part.text && !part.thought && e.author !== "user") {
              out.push(`**Abel:** ${part.text}\n`);
            }
          }
        }
        out.push(`_${calls} tool calls, ${((Date.now() - started) / 1000).toFixed(1)}s_\n`);
      }
      out.push(`_Tokens: ${used.calls} model calls, ${used.input.toLocaleString()} in (${used.cached.toLocaleString()} cached, ${pct(used.cached, used.input)}), ${used.output.toLocaleString()} out_\n`);
      tokens.push({ name: c.name, ...used });
    });
  }
});
