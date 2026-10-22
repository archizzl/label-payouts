import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FunctionTool, InMemorySessionService, LlmAgent, Runner, type Event } from "../abel/adk";
import { OpenRouterLlm, toJsonSchema } from "../abel/openrouter";

/*
 * Abel on OpenRouter (src/server/abel/openrouter.ts), against a stand-in for OpenRouter's API: a
 * whole ADK conversation goes through it (a tool call, its result, a streamed reply), and what's
 * sent is OpenRouter's OpenAI-style format.
 */

type Sent = { model: string; models?: string[]; messages: Record<string, unknown>[]; tools?: { function: { name: string; parameters: Record<string, unknown> } }[]; stream: boolean };

/** OpenRouter, answering each request with the next of these: streamed chunks, or an error status. */
function fakeOpenRouter(replies: (object[] | { status: number; error: string })[]) {
  const sent: Sent[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(init.body as string));
    const reply = replies.shift()!;
    if (!Array.isArray(reply)) return Response.json({ error: { code: reply.status, message: reply.error } }, { status: reply.status });
    const body = [": OPENROUTER PROCESSING", ...reply.map((c) => `data: ${JSON.stringify(c)}`), "data: [DONE]"].join("\n\n") + "\n\n";
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return { fetcher, sent };
}

async function converse(llm: OpenRouterLlm, tools: FunctionTool[] = []) {
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
    const { fetcher, sent } = fakeOpenRouter([
      // The model asks for the tool, its arguments arriving in two pieces.
      [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_abc", function: { name: "count_bands", arguments: '{"kind":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"all"}' } }] }, finish_reason: "tool_calls" }] },
      ],
      // Then answers, in two pieces.
      [{ choices: [{ delta: { content: "There are " } }] }, { choices: [{ delta: { content: "3 bands." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }],
    ]);
    const events = await converse(new OpenRouterLlm(["google/gemini-3.8-flash", "anthropic/claude-haiku-5.5"], "test-key", fetcher), [countBands]);

    expect(asked).toEqual([{ kind: "all" }]);
    // The reply streamed in pieces, then came whole.
    expect(events.filter((e) => e.partial).map((e) => e.content?.parts?.[0]?.text)).toEqual(["There are ", "3 bands."]);
    expect(events.at(-1)?.content?.parts?.[0]?.text).toBe("There are 3 bands.");

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
    const { fetcher } = fakeOpenRouter([{ status: 402, error: "Insufficient credits" }]);
    const events = await converse(new OpenRouterLlm(["google/gemini-3.8-flash"], "test-key", fetcher));
    expect(events.find((e) => e.errorCode)).toMatchObject({ errorCode: "402", errorMessage: "Insufficient credits" });
  });

  it("passes on an error that arrives partway through the reply", async () => {
    const { fetcher } = fakeOpenRouter([[{ choices: [{ delta: { content: "Th" } }] }, { error: { code: 503, message: "Provider overloaded" } }]]);
    const events = await converse(new OpenRouterLlm(["google/gemini-3.8-flash"], "test-key", fetcher));
    expect(events.find((e) => e.errorCode)).toMatchObject({ errorCode: "503", errorMessage: "Provider overloaded" });
  });

  it("sends only one model when there's no fallback", async () => {
    const { fetcher, sent } = fakeOpenRouter([[{ choices: [{ delta: { content: "Hi." }, finish_reason: "stop" }] }]]);
    await converse(new OpenRouterLlm(["anthropic/claude-haiku-5.5"], "test-key", fetcher));
    expect(sent[0].model).toBe("anthropic/claude-haiku-5.5");
    expect(sent[0].models).toBeUndefined();
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
