import "server-only";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import { isHTTPAccessFallbackError } from "next/dist/client/components/http-access-fallback/http-access-fallback";
import type { z } from "zod";
import { db, schema } from "@/db";
import type { Area } from "@/lib/permissions";
import { type Context, contextFor } from "../context";
import { nameMaps } from "../data";
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
  /** An admin of the account (Settings, who can sign in): as requireAdmin. */
  | "admin"
  | { area: Area; level?: "view" | "edit"; bandMay?: boolean };

/** An admin of the account they're in (for a band account the label made: of that small account, as the nav has it). */
export const isAccountAdmin = (ctx: Context) => (ctx.lens ? ctx.org.role !== "member" : ctx.isAdmin);

export type AbelTool<P extends z.ZodObject = z.ZodObject> = {
  name: string;
  description: string;
  params: P;
  needs: Needs;
  /** A change: asks the person to confirm, and is recorded in abel_actions. */
  write?: boolean;
  /** A further condition on who gets it (a payee record, a kind of account, a feature). */
  available?: (ctx: Context) => boolean | Promise<boolean>;
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
  if (tool.available && !(await tool.available(ctx))) return null;
  if (tool.needs === "anyone") return ctx;
  if (tool.needs === "admin") return isAccountAdmin(ctx) ? ctx : null;
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

/**
 * Run one of the app's server actions for a change. They answer { ok } or { error } (or nothing),
 * or redirect: to /me when the person may not (requireAccess), elsewhere when it worked (to the new
 * payout, say).
 */
export async function viaAction(call: () => Promise<unknown>, done = "Done."): Promise<{ ok: string; link?: string } | { error: string }> {
  try {
    const r = (await call()) as { ok?: string; error?: string } | null | undefined;
    if (r && typeof r === "object" && r.error) return { error: r.error };
    return { ok: (r && typeof r === "object" && r.ok) || done };
  } catch (e) {
    if (isRedirectError(e)) {
      const url = getURLFromRedirectError(e);
      return url === "/me" ? { error: NOT_ALLOWED } : { ok: done, link: url };
    }
    // notFound(): a feature this group doesn't have, or something gone.
    if (isHTTPAccessFallbackError(e)) return { error: "That isn’t available in this group." };
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

type FormValue = string | number | boolean | null | undefined;
export type Fields = Record<string, FormValue | FormValue[]>;

/** Form fields for a server action (a list: the field repeated, as checkboxes send it). */
export function form(fields: Fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    for (const one of Array.isArray(v) ? v : [v]) {
      if (one === null || one === undefined || one === false) continue;
      fd.append(k, one === true ? "on" : String(one));
    }
  }
  return fd;
}

/**
 * A change made by one of the app's server actions. `fields` turns the model's arguments into the
 * action's form (by default, the arguments as they are); for an edit it starts from the item's
 * current values, since the actions save every field. The confirm card says `label` and the
 * arguments, with ids as names.
 */
export function actionTool<P extends z.ZodObject>(t: {
  name: string;
  label: string;
  description: string;
  params: P;
  needs: Needs;
  available?: (ctx: Context) => boolean | Promise<boolean>;
  action: (fd: FormData) => Promise<unknown>;
  fields?: (ctx: Context, args: z.infer<P>) => Fields | Promise<Fields>;
  done?: string;
  summary?: (ctx: Context, args: z.infer<P>) => string | Promise<string>;
}): AbelTool {
  return abelTool<P>({
    name: t.name,
    description: t.description,
    params: t.params,
    needs: t.needs,
    available: t.available,
    write: true,
    summary: t.summary ?? ((ctx, args) => describeArgs(ctx, t.label, args)),
    run: async (ctx, args) => {
      const fields = t.fields ? await t.fields(ctx, args) : (args as Fields);
      return viaAction(() => t.action(form(fields)), t.done ?? `${t.label}: done.`);
    },
  });
}

/** Arguments whose ids name something, and what. */
const NAMED: Record<string, "band" | "person" | "release" | "track"> = {
  bandId: "band",
  bandIds: "band",
  personId: "person",
  intoId: "person",
  fromIds: "person",
  paidByPersonId: "person",
  releaseId: "release",
  releaseIds: "release",
  trackId: "track",
};

/** "deductionId" → "deduction", "effectiveFrom" → "effective from". */
const words = (key: string) =>
  key
    .replace(/Ids?$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();

/** "Add a deduction: kind percent, percent 10, band Flag Day" for the confirm card. */
export async function describeArgs(ctx: Context, label: string, args: Record<string, unknown>): Promise<string> {
  const names = Object.keys(args).some((k) => k in NAMED) ? await nameMaps(ctx.orgId) : null;
  const named = (kind: (typeof NAMED)[string], id: unknown) => names?.[kind].get(Number(id)) ?? `#${id}`;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
    let value: string;
    if (k in NAMED) value = (Array.isArray(v) ? v : [v]).map((id) => named(NAMED[k], id)).join(", ");
    else if (typeof v === "boolean") value = v ? "yes" : "no";
    else if (Array.isArray(v)) value = v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ");
    else if (typeof v === "object") value = JSON.stringify(v);
    else value = String(v);
    parts.push(k === "id" || k.endsWith("Id") && !(k in NAMED) ? `${words(k) || "item"} #${value}` : `${words(k)} ${value}`);
  }
  return parts.length ? `${label}: ${parts.join(", ")}` : label;
}
