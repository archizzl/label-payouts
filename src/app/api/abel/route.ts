import { and, desc, eq } from "drizzle-orm";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { db, schema } from "@/db";
import { type AbelChatListItem, type AbelStreamEvent, modelErrorMessage } from "@/lib/abel";
import { type Context, getContext } from "@/server/context";
import { featureOn } from "@/server/features";
import { ABEL_TOOLS, abelFor, MAX_LLM_CALLS, overDailyLimit } from "@/server/abel/agent";
import { abelConfigured } from "@/server/abel/config";
import {
  createRunConfig,
  type Content,
  getFunctionCalls,
  isIntentMismatchError,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  Runner,
  StreamingMode,
} from "@/server/abel/adk";
import { awaitingAnswer, confirmationOf, toMessages } from "@/server/abel/messages";
import { APP_NAME, chatEvents, DrizzleSessionService } from "@/server/abel/session-service";
import { describeChange } from "@/server/abel/tool";

/*
 * Abel's chat (src/server/abel). POST sends a message, or the answer to a change Abel asked to make,
 * and streams the reply back as server-sent events (AbelStreamEvent). GET lists the person's chats
 * in this group, or (?chat=ID) shows one.
 */

const NO_STORE = { "cache-control": "no-store" };

/** How long one answer may take before Abel gives up (Gemini can stall, say when its credit runs out). */
const ANSWER_TIMEOUT_MS = 90_000;

/** Who's asking, if Abel is on for them; else the response to send. */
async function who(): Promise<Context | Response> {
  let ctx: Context;
  try {
    ctx = await getContext();
  } catch (e) {
    // Not signed in (or no group yet): the helpers redirect, which an API answers with 401.
    if (isRedirectError(e)) return Response.json({ error: "Sign in first." }, { status: 401, headers: NO_STORE });
    throw e;
  }
  if (!(await featureOn("abel"))) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
  return ctx;
}

export async function GET(request: Request) {
  const ctx = await who();
  if (ctx instanceof Response) return ctx;
  const chatId = Number(new URL(request.url).searchParams.get("chat"));
  if (chatId) {
    const chat = await chatEvents(ctx.orgId, ctx.user.id, chatId);
    if (!chat) return Response.json({ error: "No such chat." }, { status: 404, headers: NO_STORE });
    return Response.json({ id: chat.chat.id, title: chat.chat.title, messages: await toMessages(ctx, chat.events) }, { headers: NO_STORE });
  }
  const chats: AbelChatListItem[] = await db
    .select({ id: schema.abelChats.id, title: schema.abelChats.title, updatedAt: schema.abelChats.updatedAt })
    .from(schema.abelChats)
    .where(and(eq(schema.abelChats.orgId, ctx.orgId), eq(schema.abelChats.userId, ctx.user.id)))
    .orderBy(desc(schema.abelChats.updatedAt))
    .limit(30);
  return Response.json({ chats }, { headers: NO_STORE });
}

type Body = { chatId?: number; message?: string; confirmation?: { id: string; confirmed: boolean } };

export async function POST(request: Request) {
  const ctx = await who();
  if (ctx instanceof Response) return ctx;
  if (!abelConfigured()) return Response.json({ error: "Abel isn’t set up on this site yet." }, { status: 503, headers: NO_STORE });
  const body = (await request.json().catch(() => ({}))) as Body;
  const message = typeof body.message === "string" ? body.message.trim().slice(0, 4000) : "";
  const confirmation =
    body.confirmation && typeof body.confirmation.id === "string" ? { id: body.confirmation.id, confirmed: body.confirmation.confirmed === true } : null;
  if (!message && !confirmation) return Response.json({ error: "Say something first." }, { status: 400, headers: NO_STORE });
  if (await overDailyLimit(ctx.user.id)) return Response.json({ error: "Abel’s daily limit is reached. Try again tomorrow." }, { status: 429, headers: NO_STORE });

  const sessions = new DrizzleSessionService(ctx.orgId);
  let chatId = Number(body.chatId) || null;
  if (chatId && !(await sessions.getSession({ appName: APP_NAME, userId: ctx.user.id, sessionId: String(chatId), config: { numRecentEvents: 1 } }))) {
    return Response.json({ error: "No such chat." }, { status: 404, headers: NO_STORE });
  }
  if (confirmation) {
    const chat = chatId ? await chatEvents(ctx.orgId, ctx.user.id, chatId) : null;
    if (!chat || !awaitingAnswer(chat.events, confirmation.id)) {
      return Response.json({ error: "That change isn’t waiting for an answer any more." }, { status: 409, headers: NO_STORE });
    }
  }
  if (!chatId) {
    if (!message) return Response.json({ error: "No such chat." }, { status: 404, headers: NO_STORE });
    chatId = Number((await sessions.createSession({ appName: APP_NAME, userId: ctx.user.id })).id);
    await db.update(schema.abelChats).set({ title: message.replace(/\s+/g, " ").slice(0, 80) }).where(eq(schema.abelChats.id, chatId));
  }
  const newMessage: Content = confirmation
    ? { role: "user", parts: [{ functionResponse: { id: confirmation.id, name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME, response: { confirmed: confirmation.confirmed } } }] }
    : { role: "user", parts: [{ text: message }] };

  const agent = await abelFor(ctx, chatId);
  const runner = new Runner({ appName: APP_NAME, agent, sessionService: sessions });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: AbelStreamEvent) => {
        // (After the person has left, there's nowhere to send it.)
        if (!request.signal.aborted) controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      };
      send({ type: "chat", chatId: chatId! });
      // Stops the run when the person leaves, or when it's taking too long.
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort("timeout"), ANSWER_TIMEOUT_MS);
      request.signal.addEventListener("abort", () => stop.abort("left"));
      try {
        for await (const event of runner.runAsync({
          userId: ctx.user.id,
          sessionId: String(chatId),
          newMessage,
          runConfig: createRunConfig({ streamingMode: StreamingMode.SSE, maxLlmCalls: MAX_LLM_CALLS }),
          abortSignal: stop.signal,
        })) {
          // (A stopped run ends with an "aborted" error of its own: the reason is said below.)
          if (event.errorMessage && !stop.signal.aborted) {
            console.error(`abel: model error ${event.errorCode ?? ""}: ${event.errorMessage}`);
            send({ type: "error", message: modelErrorMessage(event.errorCode) });
          }
          const text = (event.content?.parts ?? [])
            .filter((p) => p.text && !p.thought)
            .map((p) => p.text)
            .join("");
          if (text && event.author !== "user") send({ type: "text", text, partial: !!event.partial });
          // (Tool calls come again, whole, in the event after their streamed pieces.)
          for (const call of event.partial ? [] : getFunctionCalls(event)) {
            if (call.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME && call.id) {
              const change = confirmationOf(call);
              if (change) send({ type: "confirm", id: call.id, summary: await describeChange(ctx, ABEL_TOOLS, change.name, change.args) });
            } else if (call.name) {
              send({ type: "working", tool: call.name });
            }
          }
        }
      } catch (e) {
        if (stop.signal.aborted) {
          // Timed out (said below) or they left.
        } else if (isIntentMismatchError(e)) send({ type: "error", message: "That change isn’t waiting for an answer any more." });
        else {
          console.error("abel", e);
          send({ type: "error", message: "Something went wrong. Try again." });
        }
      }
      clearTimeout(timer);
      // An aborted run may end quietly or with an error: either way, say why it stopped.
      if (stop.signal.reason === "timeout") {
        console.error(`abel: no answer within ${ANSWER_TIMEOUT_MS / 1000}s`);
        send({ type: "error", message: "Abel took too long to answer. Try again." });
      }
      send({ type: "done" });
      controller.close();
    },
  });
  return new Response(stream, { headers: { ...NO_STORE, "content-type": "text/event-stream; charset=utf-8" } });
}
