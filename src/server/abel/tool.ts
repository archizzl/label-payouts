import "server-only";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import type { z } from "zod";
import { db, schema } from "@/db";
import type { Area } from "@/lib/permissions";
import { type Context, contextFor } from "../context";
import { FunctionTool } from "./adk";

/*
 * Abel's tools, and the one rule they all follow: Abel sees and does only what the person could in
 * the app. Each tool names the section it needs (as requireAccess would) and is given to the model
 * only if they have it; it's checked again when it runs, with that section's context (a band
 * account's own books, where the app uses them). Each tool applies the section's band limits the
 * way its page does. Changes need the person to confirm them first (ADK's tool confirmation), never
 * happen while viewing as someone, and go through the app's own server actions, which check again.
 */

export type Needs =
  /** Anyone signed in to the account (their own earnings, where things are). */
  | "anyone"
  | { area: Area; level?: "view" | "edit"; bandMay?: boolean };

export type AbelTool<P extends z.ZodObject = z.ZodObject> = {
  name: string;
  description: string;
  params: P;
  needs: Needs;
  /** A change: asks the person to confirm, and is recorded in abel_actions. */
  write?: boolean;
  /** A further condition on who gets it (a payee record, a kind of account). */
  available?: (ctx: Context) => boolean;
  /** What the change will do, in plain words, for the confirm card. */
  summary?: (ctx: Context, args: z.infer<P>) => string | Promise<string>;
  run: (ctx: Context, args: z.infer<P>) => Promise<unknown>;
};

export const abelTool = <P extends z.ZodObject>(t: AbelTool<P>) => t as unknown as AbelTool;

/** Each section's context, worked out once per request (per signed-in context): many tools share one. */
const sections = new WeakMap<Context, Map<string, Promise<Context | null>>>();

/** The context a tool runs with, or null if this person may not use it. */
export async function toolContext(ctx: Context, tool: AbelTool): Promise<Context | null> {
  if (tool.write && ctx.viewingAs) return null;
  if (tool.available && !tool.available(ctx)) return null;
  if (tool.needs === "anyone") return ctx;
  const { area, level = "view", bandMay = false } = tool.needs;
  const known = sections.get(ctx) ?? new Map<string, Promise<Context | null>>();
  sections.set(ctx, known);
  const key = `${area}|${level}|${bandMay}`;
  if (!known.has(key)) known.set(key, contextFor(area, level, { bandMay, from: ctx }));
  return known.get(key)!;
}

/** The tools this person can use, ready for the model. */
export async function toolsFor(ctx: Context, tools: AbelTool[], chatId: number | null): Promise<FunctionTool[]> {
  const allowed = await Promise.all(tools.map(async (t) => ((await toolContext(ctx, t)) ? t : null)));
  return allowed.filter((t): t is AbelTool => !!t).map((t) => functionTool(ctx, t, chatId));
}

const NOT_ALLOWED = "You can't do this in this group.";

function functionTool(ctx: Context, tool: AbelTool, chatId: number | null) {
  return new FunctionTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.params,
    requireConfirmation: !!tool.write,
    execute: async (args: unknown) => {
      const parsed = tool.params.safeParse(args);
      if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
      const scoped = await toolContext(ctx, tool);
      if (!scoped) return { error: NOT_ALLOWED };
      let result: unknown;
      try {
        result = await tool.run(scoped, parsed.data);
      } catch (e) {
        result = { error: e instanceof Error ? e.message : String(e) };
      }
      if (tool.write) await record(ctx, chatId, tool.name, parsed.data, result);
      return result;
    },
  });
}

async function record(ctx: Context, chatId: number | null, tool: string, args: Record<string, unknown>, result: unknown) {
  const failed = !!result && typeof result === "object" && "error" in result;
  await db.insert(schema.abelActions).values({
    orgId: ctx.orgId,
    userId: ctx.user.id,
    chatId,
    tool,
    args,
    status: failed ? "failed" : "done",
    result: JSON.stringify(result).slice(0, 2000),
  });
}

type ActionResult = { ok?: string; error?: string } | null | void;

/**
 * Run one of the app's server actions for a change. They answer { ok } or { error }, or redirect:
 * to /me when the person may not (requireAccess), elsewhere when it worked (to the new payout, say).
 */
export async function viaAction(call: () => Promise<ActionResult>, done = "Done."): Promise<{ ok: string; link?: string } | { error: string }> {
  try {
    const r = await call();
    if (r?.error) return { error: r.error };
    return { ok: r?.ok ?? done };
  } catch (e) {
    if (isRedirectError(e)) {
      const url = getURLFromRedirectError(e);
      return url === "/me" ? { error: NOT_ALLOWED } : { ok: done, link: url };
    }
    throw e;
  }
}

/** The confirm card's words for a change the model asked to make (tool name and arguments). */
export async function describeChange(ctx: Context, tools: AbelTool[], name: string, args: unknown): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  const parsed = tool?.params.safeParse(args);
  if (!tool?.summary || !parsed?.success) return name.replace(/_/g, " ");
  try {
    return await tool.summary(ctx, parsed.data);
  } catch {
    return name.replace(/_/g, " ");
  }
}

/** Form fields for a server action. */
export function form(fields: Record<string, string | number | boolean | null | undefined>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined || v === false) continue;
    fd.set(k, v === true ? "on" : String(v));
  }
  return fd;
}
