import "server-only";
import { BaseLlm, type BaseLlmConnection, type LlmRequest, type LlmResponse } from "./adk";

/*
 * Abel on an OpenAI-style chat API: OpenRouter (https://openrouter.ai: one key for Gemini, Claude,
 * GPT and others, falling back to the next model when one is busy) or DeepSeek. ADK speaks Gemini's
 * format, so this model class translates: Gemini contents, tools and schemas into the OpenAI-style
 * chat request, and its streamed reply back into ADK's responses (text pieces marked partial, then
 * the whole turn).
 */

/** Where to send the chat and how: the API's address, extra headers, and extra fields for every request. */
export type ChatApi = { url: string; headers?: Record<string, string>; extra?: Record<string, unknown> };

export const OPENROUTER: ChatApi = {
  url: "https://openrouter.ai/api/v1/chat/completions",
  // How the app shows up in OpenRouter's dashboard.
  headers: { "x-title": "labelmaker", "http-referer": "https://labelmaker.ing" },
};

export const DEEPSEEK: ChatApi = {
  url: "https://api.deepseek.com/chat/completions",
  // Thinking is on by default, and with tools DeepSeek then wants its reasoning sent back on every
  // later request (ADK has nowhere to keep it), so it's off.
  extra: { thinking: { type: "disabled" } },
};

type Part = NonNullable<NonNullable<LlmRequest["contents"][number]["parts"]>[number]>;
type Schema = Record<string, unknown>;

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type ChatTool = { type: "function"; function: { name: string; description?: string; parameters: Schema } };

/** Gemini's schema (types in capitals, "nullable") as JSON Schema, which OpenAI-style APIs take. */
export function toJsonSchema(schema: unknown): Schema {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  const s = schema as Schema;
  const out: Schema = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "type" && typeof v === "string") out.type = v.toLowerCase() === "type_unspecified" ? undefined : v.toLowerCase();
    else if (k === "properties" && v && typeof v === "object") out.properties = Object.fromEntries(Object.entries(v).map(([p, ps]) => [p, toJsonSchema(ps)]));
    else if (k === "items") out.items = toJsonSchema(v);
    else if (k === "anyOf" && Array.isArray(v)) out.anyOf = v.map(toJsonSchema);
    else if (k === "nullable") continue;
    else if (k === "propertyOrdering") continue;
    else if (["minItems", "maxItems", "minLength", "maxLength"].includes(k) && typeof v === "string") out[k] = Number(v);
    else out[k] = v;
  }
  if (s.nullable === true && typeof out.type === "string") out.type = [out.type, "null"];
  if (out.type === undefined) delete out.type;
  if (out.type === "object" && !out.properties) out.properties = {};
  return out;
}

function systemText(instruction: unknown): string {
  if (!instruction) return "";
  if (typeof instruction === "string") return instruction;
  const parts = Array.isArray(instruction) ? instruction : ((instruction as { parts?: unknown[] }).parts ?? [instruction]);
  return parts.map((p) => (typeof p === "string" ? p : ((p as Part).text ?? ""))).join("\n");
}

const newCallId = () => `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

/** ADK's request as OpenRouter's messages and tools. */
export function toChatRequest(req: LlmRequest): { messages: ChatMessage[]; tools: ChatTool[] } {
  const messages: ChatMessage[] = [];
  const system = systemText(req.config?.systemInstruction);
  if (system) messages.push({ role: "system", content: system });
  // Calls whose results haven't come back yet, for results without an id (paired by name, in order).
  const waiting: { id: string; name: string }[] = [];
  for (const content of req.contents) {
    const parts = (content.parts ?? []).filter((p) => !p.thought);
    const text = parts
      .filter((p) => p.text)
      .map((p) => p.text)
      .join("");
    if (content.role === "model") {
      const calls = parts
        .filter((p) => p.functionCall)
        .map((p) => {
          const id = p.functionCall!.id || newCallId();
          waiting.push({ id, name: p.functionCall!.name ?? "" });
          return { id, type: "function" as const, function: { name: p.functionCall!.name ?? "", arguments: JSON.stringify(p.functionCall!.args ?? {}) } };
        });
      if (text || calls.length) messages.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    for (const p of parts) {
      if (!p.functionResponse) continue;
      const r = p.functionResponse;
      const i = r.id ? waiting.findIndex((w) => w.id === r.id) : waiting.findIndex((w) => w.name === r.name);
      const id = i >= 0 ? waiting.splice(i, 1)[0].id : (r.id ?? newCallId());
      messages.push({ role: "tool", tool_call_id: id, content: JSON.stringify(r.response ?? {}) });
    }
    if (text) messages.push({ role: "user", content: text });
  }
  const tools: ChatTool[] = (req.config?.tools ?? []).flatMap((t) =>
    ("functionDeclarations" in t ? (t.functionDeclarations ?? []) : []).map((d) => ({
      type: "function" as const,
      function: {
        name: d.name ?? "",
        ...(d.description ? { description: d.description } : {}),
        parameters: d.parametersJsonSchema ? (d.parametersJsonSchema as Schema) : toJsonSchema(d.parameters),
      },
    })),
  );
  return { messages: paired(messages), tools };
}

/** What a call with no result gets: it didn't happen (a change waiting on its confirm card, or one that never finished). */
export const NO_RESULT = { error: "Not done: it wasn't confirmed, or didn't finish." };

/**
 * Every tool call followed straight away by a result for it, as OpenAI-style APIs insist (DeepSeek
 * refuses the whole request otherwise). A result that came later (a change confirmed after other
 * messages) moves up to its call; a call with none gets NO_RESULT; a result whose call isn't here
 * (cut off the start of a long chat) is dropped.
 */
export function paired(messages: ChatMessage[]): ChatMessage[] {
  const results = new Map<string, ChatMessage>();
  for (const m of messages) if (m.role === "tool") results.set(m.tool_call_id, m);
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "tool") continue;
    out.push(m);
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    for (const call of m.tool_calls) out.push(results.get(call.id) ?? { role: "tool", tool_call_id: call.id, content: JSON.stringify(NO_RESULT) });
  }
  return out;
}

type Choice = {
  delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] };
  message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] };
  finish_reason?: string | null;
};
type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** DeepSeek: how much of the prompt was read from its cache. */
  prompt_cache_hit_tokens?: number;
  /** OpenRouter and other OpenAI-style APIs: the same. */
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
};
type Chunk = { choices?: Choice[]; usage?: Usage; error?: { code?: number | string; message?: string } };

/** Usage as ADK has it (Gemini's names), including how much of the prompt came from the service's cache. */
const usageMetadata = (u: Usage) => ({
  promptTokenCount: u.prompt_tokens,
  candidatesTokenCount: u.completion_tokens,
  totalTokenCount: u.total_tokens,
  cachedContentTokenCount: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens,
  thoughtsTokenCount: u.completion_tokens_details?.reasoning_tokens,
});

const FINISH: Record<string, string> = { stop: "STOP", tool_calls: "STOP", length: "MAX_TOKENS", content_filter: "SAFETY" };

function parseArgs(raw: string | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** The whole turn, as ADK's response: the text, then each tool call. */
function finalResponse(text: string, calls: { id?: string; name?: string; arguments?: string }[], finish: string | null, usage: Chunk["usage"]): LlmResponse {
  const parts: Part[] = [];
  if (text) parts.push({ text });
  for (const c of calls) if (c.name) parts.push({ functionCall: { id: c.id || newCallId(), name: c.name, args: parseArgs(c.arguments) } });
  return {
    content: { role: "model", parts },
    partial: false,
    turnComplete: true,
    ...(finish ? { finishReason: (FINISH[finish] ?? "OTHER") as LlmResponse["finishReason"] } : {}),
    ...(usage ? { usageMetadata: usageMetadata(usage) } : {}),
  };
}

const failure = (code: number | string | undefined, message: string | undefined): LlmResponse => ({
  errorCode: String(code ?? "error"),
  errorMessage: message || "OpenRouter didn’t answer.",
  turnComplete: true,
});

export class ChatApiLlm extends BaseLlm {
  /** The models to try, in order (OpenRouter moves to the next when one is busy or down). */
  private readonly models: string[];

  constructor(
    private readonly api: ChatApi,
    models: string[],
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = (...a) => fetch(...a),
  ) {
    super({ model: models[0] });
    this.models = models;
  }

  async *generateContentAsync(llmRequest: LlmRequest, stream = false, abortSignal?: AbortSignal): AsyncGenerator<LlmResponse, void> {
    this.maybeAppendUserContent(llmRequest);
    const { messages, tools } = toChatRequest(llmRequest);
    const body = {
      ...this.api.extra,
      model: this.models[0],
      ...(this.models.length > 1 ? { models: this.models } : {}),
      messages,
      ...(tools.length ? { tools } : {}),
      ...(llmRequest.config?.temperature !== undefined ? { temperature: llmRequest.config.temperature } : {}),
      ...(llmRequest.config?.maxOutputTokens ? { max_tokens: llmRequest.config.maxOutputTokens } : {}),
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    };
    const res = await this.fetcher(this.api.url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", ...this.api.headers },
      body: JSON.stringify(body),
      signal: abortSignal,
    });
    if (!res.ok || !res.body) {
      // (OpenRouter and DeepSeek both answer { error: { message } }; DeepSeek's code is a word, so the status is kept.)
      const err = (await res.json().catch(() => ({}))) as Chunk;
      yield failure(typeof err.error?.code === "number" ? err.error.code : res.status, err.error?.message ?? res.statusText);
      return;
    }
    if (!stream) {
      const data = (await res.json()) as Chunk;
      if (data.error) return yield failure(data.error.code, data.error.message);
      const choice = data.choices?.[0];
      const calls = (choice?.message?.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function?.name, arguments: c.function?.arguments }));
      yield finalResponse(choice?.message?.content ?? "", calls, choice?.finish_reason ?? null, data.usage);
      return;
    }

    let text = "";
    const calls: { id?: string; name?: string; arguments: string }[] = [];
    let finish: string | null = null;
    let usage: Chunk["usage"];
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        // (Lines starting ":" are OpenRouter keeping the connection open.)
        const line = raw.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let chunk: Chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error) return yield failure(chunk.error.code, chunk.error.message);
        // (A chunk can carry the usage with no choices, at the end.)
        if (chunk.usage) usage = chunk.usage;
        for (const choice of chunk.choices ?? []) {
          if (choice.finish_reason) finish = choice.finish_reason;
          const delta = choice.delta;
          if (delta?.content) {
            text += delta.content;
            yield { content: { role: "model", parts: [{ text: delta.content }] }, partial: true };
          }
          for (const tc of delta?.tool_calls ?? []) {
            const c = (calls[tc.index] ??= { arguments: "" });
            if (tc.id) c.id = tc.id;
            if (tc.function?.name) c.name = tc.function.name;
            if (tc.function?.arguments) c.arguments += tc.function.arguments;
          }
        }
      }
    }
    yield finalResponse(text, calls.filter(Boolean), finish, usage);
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error("Abel doesn’t use live (voice) sessions.");
  }
}
