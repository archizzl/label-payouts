import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FunctionTool, InMemorySessionService, LlmAgent, Runner, type Event } from "../abel/adk";
import { abelProvider } from "../abel/config";
import { ChatApiLlm, DEEPSEEK, OPENROUTER, toJsonSchema } from "../abel/openai-compatible";

/*
 * Abel on OpenRouter or DeepSeek (src/server/abel/openai-compatible.ts), against a stand-in for
 * their API: a whole ADK conversation goes through it (a tool call, its result, a streamed reply),
 * and what's sent is the OpenAI-style format.
 */

type Sent = { url: string; auth: string; thinking?: unknown; model: string; models?: string[]; messages: Record<string, unknown>[]; tools?: { function: { name: string; parameters: Record<string, unknown> } }[]; stream: boolean };

/** The API, answering each request with the next of these: streamed chunks, or an error status. */
function fakeApi(replies: (object[] | { status: number; error: string })[]) {
  const sent: Sent[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    sent.push({ ...JSON.parse(init.body as string), url, auth: (init.headers as Record<string, string>).authorization });
    const reply = replies.shift()!;
    if (!Array.isArray(reply)) return Response.json({ error: { code: reply.status, message: reply.error } }, { status: reply.status });
    const body = [": OPENROUTER PROCESSING", ...reply.map((c) => `data: ${JSON.stringify(c)}`), "data: [DONE]"].join("\n\n") + "\n\n";
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return { fetcher, sent };
}

async function converse(llm: ChatApiLlm, tools: FunctionTool[] = []) {
  const sessions = new InMemorySessionService();
  const session = await sessions.createSession({ appName: "abel", userId: "u" });
  const runner = new Runner({ appName: "abel", agent: new LlmAgent({ name: "abel", model: llm, instruction: "You are Abel.", tools }), sessionService: sessions });
  const events: Event[] = [];
  for await (const e of runner.runAsync({
    userId: "u",
    sessionId: session.id,
    newMessage: { role: "user", parts: [{ text: "How many bands are there?" }] },
    runConfig: { streamingMode: "sse" as never },
  }))
    events.push(e);
  return events;
}

describe("Abel on OpenRouter", () => {
  it("calls a tool, sends its result back with the call's id, and streams the reply", async () => {
    const asked: unknown[] = [];
    const countBands = new FunctionTool({
      name: "count_bands",
      description: "How many bands",
      parameters: z.object({ kind: z.enum(["all", "active"]), limit: z.number().int().optional() }),
      execute: async (args) => {
        asked.push(args);
        return { bands: 3 };
      },
    });
    const { fetcher, sent } = fakeApi([
      // The model asks for the tool, its arguments arriving in two pieces.
      [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_abc", function: { name: "count_bands", arguments: '{"kind":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"all"}' } }] }, finish_reason: "tool_calls" }] },
      ],
      // Then answers, in two pieces.
      [{ choices: [{ delta: { content: "There are " } }] }, { choices: [{ delta: { content: "3 bands." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_cache_hit_tokens: 8 } }],
    ]);
    const events = await converse(new ChatApiLlm(OPENROUTER, ["google/gemini-3.8-flash", "anthropic/claude-haiku-5.5"], "test-key", fetcher), [countBands]);

    expect(asked).toEqual([{ kind: "all" }]);
    // The reply streamed in pieces, then came whole.
    expect(events.filter((e) => e.partial).map((e) => e.content?.parts?.[0]?.text)).toEqual(["There are ", "3 bands."]);
    expect(events.at(-1)?.content?.parts?.[0]?.text).toBe("There are 3 bands.");
    expect(events.at(-1)?.usageMetadata).toMatchObject({ promptTokenCount: 10, candidatesTokenCount: 4, cachedContentTokenCount: 8 });

    // The first request: the instruction, the question, the tool as JSON Schema, and the fallback model.
    const [first, second] = sent;
    expect(first.model).toBe("google/gemini-3.8-flash");
    expect(first.models).toEqual(["google/gemini-3.8-flash", "anthropic/claude-haiku-5.5"]);
    expect(first.stream).toBe(true);
    expect(first.messages[0]).toMatchObject({ role: "system" });
    expect(String(first.messages[0].content)).toContain("You are Abel.");
    expect(first.messages.at(-1)).toEqual({ role: "user", content: "How many bands are there?" });
    expect(first.tools?.[0].function.name).toBe("count_bands");
    expect(first.tools?.[0].function.parameters).toMatchObject({
      type: "object",
      properties: { kind: { type: "string", enum: ["all", "active"] }, limit: { type: "integer" } },
      required: ["kind"],
    });

    // The second: the model's call and the tool's result, paired by the call's id.
    const call = second.messages.find((m) => m.role === "assistant") as { tool_calls: { id: string; function: { name: string; arguments: string } }[] };
    expect(call.tool_calls).toEqual([{ id: "call_abc", type: "function", function: { name: "count_bands", arguments: '{"kind":"all"}' } }]);
    expect(second.messages.find((m) => m.role === "tool")).toEqual({ role: "tool", tool_call_id: "call_abc", content: '{"bands":3}' });
  });

  it("passes on OpenRouter's errors, for Abel to explain", async () => {
    const { fetcher } = fakeApi([{ status: 402, error: "Insufficient credits" }]);
    const events = await converse(new ChatApiLlm(OPENROUTER, ["google/gemini-3.8-flash"], "test-key", fetcher));
    expect(events.find((e) => e.errorCode)).toMatchObject({ errorCode: "402", errorMessage: "Insufficient credits" });
  });

  it("passes on an error that arrives partway through the reply", async () => {
    const { fetcher } = fakeApi([[{ choices: [{ delta: { content: "Th" } }] }, { error: { code: 503, message: "Provider overloaded" } }]]);
    const events = await converse(new ChatApiLlm(OPENROUTER, ["google/gemini-3.8-flash"], "test-key", fetcher));
    expect(events.find((e) => e.errorCode)).toMatchObject({ errorCode: "503", errorMessage: "Provider overloaded" });
  });

  it("sends only one model when there's no fallback", async () => {
    const { fetcher, sent } = fakeApi([[{ choices: [{ delta: { content: "Hi." }, finish_reason: "stop" }] }]]);
    await converse(new ChatApiLlm(OPENROUTER, ["anthropic/claude-haiku-5.5"], "test-key", fetcher));
    expect(sent[0].model).toBe("anthropic/claude-haiku-5.5");
    expect(sent[0].models).toBeUndefined();
  });
});

describe("Abel on DeepSeek", () => {
  it("sends DeepSeek its key and one model, with thinking off", async () => {
    const { fetcher, sent } = fakeApi([[{ choices: [{ delta: { content: "Hi." }, finish_reason: "stop" }] }]]);
    const events = await converse(new ChatApiLlm(DEEPSEEK, ["deepseek-flash"], "ds-key", fetcher));
    expect(events.at(-1)?.content?.parts?.[0]?.text).toBe("Hi.");
    expect(sent[0]).toMatchObject({ url: "https://api.deepseek.com/chat/completions", auth: "Bearer ds-key", model: "deepseek-flash", thinking: { type: "disabled" } });
    expect(sent[0].models).toBeUndefined();
  });

  it("keeps the status when DeepSeek's error code is a word", async () => {
    const fetcher = (async () => Response.json({ error: { message: "Insufficient Balance", code: "invalid_request_error" } }, { status: 402 })) as unknown as typeof fetch;
    const events = await converse(new ChatApiLlm(DEEPSEEK, ["deepseek-flash"], "ds-key", fetcher));
    expect(events.find((e) => e.errorCode)).toMatchObject({ errorCode: "402", errorMessage: "Insufficient Balance" });
  });
});

describe("abelProvider", () => {
  it("uses the service named, else the first with a key", () => {
    expect(abelProvider({})).toBeNull();
    expect(abelProvider({ GEMINI_API_KEY: "g" })).toBe("gemini");
    expect(abelProvider({ GEMINI_API_KEY: "g", DEEPSEEK_API_KEY: "d" })).toBe("deepseek");
    expect(abelProvider({ GEMINI_API_KEY: "g", DEEPSEEK_API_KEY: "d", OPENROUTER_API_KEY: "o" })).toBe("openrouter");
    expect(abelProvider({ GEMINI_API_KEY: "g", DEEPSEEK_API_KEY: "d", ABEL_PROVIDER: "gemini" })).toBe("gemini");
    // Named, but no key for it: not set up.
    expect(abelProvider({ GEMINI_API_KEY: "g", ABEL_PROVIDER: "deepseek" })).toBeNull();
  });
});

describe("paired", () => {
  it("gives every tool call its result straight after it", async () => {
    const { paired, NO_RESULT } = await import("../abel/openai-compatible");
    const call = (id: string) => ({ id, type: "function" as const, function: { name: "x", arguments: "{}" } });
    const result = (id: string) => ({ role: "tool" as const, tool_call_id: id, content: "{}" });
    expect(
      paired([
        { role: "user", content: "add a shirt" },
        // A change waiting on its confirm card when they wrote again: no result.
        { role: "assistant", content: null, tool_calls: [call("a")] },
        { role: "user", content: "make it blue" },
        // One whose result came after other messages.
        { role: "assistant", content: null, tool_calls: [call("b")] },
        { role: "user", content: "and red" },
        result("b"),
        // A result whose call was cut off the start of the chat.
        result("gone"),
      ]),
    ).toEqual([
      { role: "user", content: "add a shirt" },
      { role: "assistant", content: null, tool_calls: [call("a")] },
      { role: "tool", tool_call_id: "a", content: JSON.stringify(NO_RESULT) },
      { role: "user", content: "make it blue" },
      { role: "assistant", content: null, tool_calls: [call("b")] },
      result("b"),
      { role: "user", content: "and red" },
    ]);
  });
});

describe("toJsonSchema", () => {
  it("turns Gemini's schema into JSON Schema", () => {
    expect(
      toJsonSchema({
        type: "OBJECT",
        properties: { name: { type: "STRING", nullable: true }, tags: { type: "ARRAY", items: { type: "STRING" }, minItems: "1" } },
        required: ["tags"],
        propertyOrdering: ["name", "tags"],
      }),
    ).toEqual({
      type: "object",
      properties: { name: { type: ["string", "null"] }, tags: { type: "array", items: { type: "string" }, minItems: 1 } },
      required: ["tags"],
    });
    expect(toJsonSchema(undefined)).toEqual({ type: "object", properties: {} });
  });
});
