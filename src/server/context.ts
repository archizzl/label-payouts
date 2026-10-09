import "server-only";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db, schema } from "@/db";
import { type Access, type Area, can, normalizeBandAreas, normalizePermissions } from "@/lib/permissions";
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
  /** What they can see and change, from their role and member type (src/lib/permissions.ts). */
  access: Access;
  /** Their member type's name, if they have one. */
  memberType: string | null;
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
  const isAdmin = org.role !== "member";
  const { access, memberType } = await accessFor(org.id, session.user.id, isAdmin, person?.id ?? null);
  return {
    user: { id: session.user.id, name: session.user.name, email: session.user.email },
    org,
    orgId: org.id,
    role: org.role,
    isAdmin,
    access,
    memberType,
    person: person ?? null,
    accounts,
  };
});

/** What someone can do in an account: everything for admins, else what their member type grants. */
export async function accessFor(orgId: string, userId: string, isAdmin: boolean, personId: number | null) {
  if (isAdmin) return { access: { admin: true, permissions: {}, bandAreas: [], bandIds: [] } satisfies Access, memberType: null };
  const [type] = await db
    .select({ type: schema.memberTypes })
    .from(schema.memberTypeAssignments)
    .innerJoin(schema.memberTypes, eq(schema.memberTypes.id, schema.memberTypeAssignments.memberTypeId))
    .where(and(eq(schema.memberTypeAssignments.orgId, orgId), eq(schema.memberTypeAssignments.userId, userId)));
  const bandIds =
    personId === null
      ? []
      : (
          await db
            .select({ bandId: schema.bandMemberships.bandId })
            .from(schema.bandMemberships)
            .where(and(eq(schema.bandMemberships.orgId, orgId), eq(schema.bandMemberships.personId, personId), eq(schema.bandMemberships.active, true)))
        ).map((r) => r.bandId);
  const access: Access = {
    admin: false,
    permissions: normalizePermissions(type?.type.permissions),
    bandAreas: normalizeBandAreas(type?.type.bandAreas),
    bandIds,
  };
  return { access, memberType: type?.type.name ?? null };
}

/**
 * For pages and actions in one section: anyone whose role or member type allows it (viewing, or
 * changing things). Everyone else is sent to their own earnings page.
 */
export async function requireAccess(area: Area, level: "view" | "edit" = "view"): Promise<Context> {
  const ctx = await getContext();
  if (!can(ctx.access, area, level)) redirect("/me");
  return ctx;
}

/** For pages and actions only admins may use (settings, who can sign in): members are sent to their own earnings page. */
export async function requireAdmin(): Promise<Context> {
  const ctx = await getContext();
  if (!ctx.isAdmin) redirect("/me");
  return ctx;
}
