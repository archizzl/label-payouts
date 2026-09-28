import "server-only";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db, schema } from "@/db";
import { auth } from "./auth";

/*
 * Who's asking, and for which account. Every page and action gets its data through this: it checks
 * the session, finds the account (label or band) they're working in and their role there, and every
 * query is then scoped to that account's orgId.
 */

export type Role = "owner" | "admin" | "member";
export type AccountKind = "label" | "band";

export type Account = { id: string; name: string; slug: string; kind: AccountKind; role: Role };

export type Context = {
  user: { id: string; name: string; email: string };
  /** The account they're working in. */
  org: Account;
  orgId: string;
  role: Role;
  /** Owners and admins manage everything; members see their own money and their bands' totals. */
  isAdmin: boolean;
  /** Their payee record in this account (for "my earnings"), once linked. */
  person: typeof schema.people.$inferSelect | null;
  /** Every account they belong to, for the account switcher. */
  accounts: Account[];
};

/** The signed-in session, or null. */
export const getSession = cache(async () => auth.api.getSession({ headers: await headers() }));

/** Every label/band account this user belongs to. */
export async function accountsFor(userId: string): Promise<Account[]> {
  const rows = await db
    .select({ org: schema.organization, role: schema.member.role })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
    .where(eq(schema.member.userId, userId));
  return rows
    .map(({ org, role }) => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
      kind: (org.kind === "band" ? "band" : "label") as AccountKind,
      role: (["owner", "admin"].includes(role) ? role : "member") as Role,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The request's context. Sends people who aren't signed in to /login, and people with no account
 * yet to /welcome to create one.
 */
export const getContext = cache(async (): Promise<Context> => {
  const session = await getSession();
  if (!session) redirect("/login");
  const accounts = await accountsFor(session.user.id);
  if (accounts.length === 0) redirect("/welcome");
  const org = accounts.find((a) => a.id === session.session.activeOrganizationId) ?? accounts[0];
  if (org.id !== session.session.activeOrganizationId) {
    // Remember it, so the next request doesn't have to guess.
    await db.update(schema.session).set({ activeOrganizationId: org.id }).where(eq(schema.session.id, session.session.id));
  }
  const [person] = await db
    .select()
    .from(schema.people)
    .where(and(eq(schema.people.orgId, org.id), eq(schema.people.userId, session.user.id)));
  return {
    user: { id: session.user.id, name: session.user.name, email: session.user.email },
    org,
    orgId: org.id,
    role: org.role,
    isAdmin: org.role !== "member",
    person: person ?? null,
    accounts,
  };
});

/** For pages and actions only admins may use: members are sent to their own earnings page. */
export async function requireAdmin(): Promise<Context> {
  const ctx = await getContext();
  if (!ctx.isAdmin) redirect("/me");
  return ctx;
}
