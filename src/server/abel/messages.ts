import "server-only";
import type { AbelMessage } from "@/lib/abel";
import type { Context } from "../context";
import { ABEL_TOOLS } from "./agent";
import { type Event, getFunctionCalls, getFunctionResponses, REQUEST_CONFIRMATION_FUNCTION_CALL_NAME } from "./adk";
import { describeChange } from "./tool";

/** A confirmation request's change: the tool call it's asking about. */
export function confirmationOf(call: { args?: Record<string, unknown> }) {
  const original = call.args?.originalFunctionCall as { name?: string; args?: unknown } | undefined;
  return original?.name ? { name: original.name, args: original.args ?? {} } : null;
}

const textOf = (e: Event) =>
  (e.content?.parts ?? [])
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join("");

/** Whether Abel asked to make this change in these events and nobody has answered yet (each is answered once). */
export function awaitingAnswer(events: Event[], id: string) {
  const asked = events.some((e) => e.author !== "user" && getFunctionCalls(e).some((c) => c.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME && c.id === id));
  const answered = events.some((e) => e.author === "user" && getFunctionResponses(e).some((r) => r.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME && r.id === id));
  return asked && !answered;
}

/** A stored chat as the panel shows it: what was said, and each change Abel asked to make with its answer. */
export async function toMessages(ctx: Context, events: Event[]): Promise<AbelMessage[]> {
  const answers = new Map<string, boolean>();
  for (const e of events) {
    if (e.author !== "user") continue;
    for (const r of getFunctionResponses(e)) {
      if (r.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME && r.id) answers.set(r.id, (r.response as { confirmed?: boolean })?.confirmed === true);
    }
  }
  const out: AbelMessage[] = [];
  for (const e of events) {
    const text = textOf(e);
    if (e.author === "user") {
      if (text) out.push({ kind: "user", text });
      continue;
    }
    if (text) out.push({ kind: "abel", text });
    for (const call of getFunctionCalls(e)) {
      if (call.name !== REQUEST_CONFIRMATION_FUNCTION_CALL_NAME || !call.id) continue;
      const change = confirmationOf(call);
      if (!change) continue;
      const answer = answers.get(call.id);
      out.push({
        kind: "confirm",
        id: call.id,
        summary: await describeChange(ctx, ABEL_TOOLS, change.name, change.args),
        answer: answer === undefined ? null : answer ? "confirmed" : "declined",
      });
    }
  }
  return out;
}
