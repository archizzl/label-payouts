import "server-only";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import {
  type AppendEventRequest,
  BaseSessionService,
  type CreateSessionRequest,
  type DeleteSessionRequest,
  type Event,
  type GetSessionRequest,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type Session,
} from "./adk";

/*
 * Abel's chats, kept in Postgres (abel_chats and abel_events) for ADK's Runner. One service per
 * request, for one account: a chat is only ever found in the account it was started in, by the
 * person who started it.
 */

export const APP_NAME = "abel";

/** How much of a chat the model is sent: the last this many events. */
const RECENT_EVENTS = 60;

const toTime = (s: string) => Date.parse(`${s.replace(" ", "T")}Z`) / 1000;

export class DrizzleSessionService extends BaseSessionService {
  constructor(private readonly orgId: string) {
    super();
  }

  async createSession({ userId, state }: CreateSessionRequest): Promise<Session> {
    const [chat] = await db
      .insert(schema.abelChats)
      .values({ orgId: this.orgId, userId, state: state ?? {} })
      .returning();
    return { id: String(chat.id), appName: APP_NAME, userId, state: chat.state, events: [], lastUpdateTime: toTime(chat.updatedAt) };
  }

  private async chat(userId: string, sessionId: string) {
    const id = Number(sessionId);
    if (!Number.isInteger(id)) return null;
    const [chat] = await db
      .select()
      .from(schema.abelChats)
      .where(and(eq(schema.abelChats.id, id), eq(schema.abelChats.orgId, this.orgId), eq(schema.abelChats.userId, userId)));
    return chat ?? null;
  }

  async getSession({ userId, sessionId, config }: GetSessionRequest): Promise<Session | undefined> {
    const chat = await this.chat(userId, sessionId);
    if (!chat) return undefined;
    const limit = config?.numRecentEvents ?? RECENT_EVENTS;
    const rows = await db
      .select({ event: schema.abelEvents.event })
      .from(schema.abelEvents)
      .where(eq(schema.abelEvents.chatId, chat.id))
      .orderBy(desc(schema.abelEvents.id))
      .limit(limit);
    let events = rows.reverse().map((r) => r.event as unknown as Event);
    if (config?.afterTimestamp) events = events.filter((e) => e.timestamp > config.afterTimestamp!);
    // A long chat's window shouldn't start partway through a tool call: start at a message from the person.
    if (rows.length === limit) {
      const start = events.findIndex((e) => e.author === "user" && e.content?.parts?.some((p) => p.text));
      events = start >= 0 ? events.slice(start) : [];
    }
    return { id: String(chat.id), appName: APP_NAME, userId, state: chat.state, events, lastUpdateTime: toTime(chat.updatedAt) };
  }

  async listSessions({ userId, limit }: ListSessionsRequest): Promise<ListSessionsResponse> {
    const chats = await db
      .select()
      .from(schema.abelChats)
      .where(and(eq(schema.abelChats.orgId, this.orgId), userId ? eq(schema.abelChats.userId, userId) : undefined))
      .orderBy(desc(schema.abelChats.updatedAt))
      .limit(limit ?? 50);
    const sessions = chats.map((c) => ({ id: String(c.id), appName: APP_NAME, userId: c.userId, state: {}, events: [], lastUpdateTime: toTime(c.updatedAt) }));
    return { sessions, page: 1, limit: sessions.length, totalItems: sessions.length, totalPages: sessions.length ? 1 : 0 };
  }

  async deleteSession({ userId, sessionId }: DeleteSessionRequest): Promise<void> {
    const chat = await this.chat(userId, sessionId);
    if (chat) await db.delete(schema.abelChats).where(eq(schema.abelChats.id, chat.id));
  }

  async appendEvent({ session, event }: AppendEventRequest): Promise<Event> {
    const stored = await super.appendEvent({ session, event });
    // Streamed pieces of a reply aren't kept: the whole reply follows them.
    if (event.partial) return stored;
    const chatId = Number(session.id);
    const json = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
    await db.transaction(async (tx) => {
      // An event saved before is replaced; anything else is added. (Whether it's in the session's
      // memory says nothing: ADK puts a confirmed tool's result there before asking to save it.)
      const replaced = await tx
        .update(schema.abelEvents)
        .set({ event: json })
        .where(and(eq(schema.abelEvents.chatId, chatId), sql`${schema.abelEvents.event}->>'id' = ${stored.id}`))
        .returning({ id: schema.abelEvents.id });
      if (!replaced.length) {
        await tx.insert(schema.abelEvents).values({ chatId, orgId: this.orgId, author: stored.author === "user" ? "user" : "abel", event: json });
      }
      await tx
        .update(schema.abelChats)
        .set({ state: { ...session.state }, updatedAt: sql`to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')` })
        .where(and(eq(schema.abelChats.id, chatId), eq(schema.abelChats.orgId, this.orgId)));
    });
    return stored;
  }
}

/** A chat's events in order, for showing it again (all of them, not just the model's recent window). */
export async function chatEvents(orgId: string, userId: string, chatId: number) {
  const [chat] = await db
    .select()
    .from(schema.abelChats)
    .where(and(eq(schema.abelChats.id, chatId), eq(schema.abelChats.orgId, orgId), eq(schema.abelChats.userId, userId)));
  if (!chat) return null;
  const rows = await db
    .select({ event: schema.abelEvents.event })
    .from(schema.abelEvents)
    .where(eq(schema.abelEvents.chatId, chat.id))
    .orderBy(asc(schema.abelEvents.id));
  return { chat, events: rows.map((r) => r.event as unknown as Event) };
}
