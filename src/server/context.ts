import "server-only";
import { and, eq } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db, schema } from "@/db";
import { type Access, type Area, can, normalizeBandAreas, normalizePermissions } from "@/lib/permissions";
import { auth } from "./auth";
import { cookieValues, SESSION_TOKEN } from "@/lib/auth-cookies";
import { managingLabel } from "./band-accounts";
import { setOwnBooks } from "./own-books";

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
  /**
   * A band account the label made for one of its bands (a sub-account): the label, the link to its
   * books, and whether the band keeps its own books here too.
   */
  managedBy: { linkId: number; labelOrgId: string; labelName: string; bandId: number; ownBooks: boolean } | null;
  /** A label admin looking at the app as one of its bands or people would see it: read-only. */
  viewingAs: ViewingAs | null;
  /**
   * A label-made band account looking at the label's books, narrowed to its band (see bandLens):
   * orgId is the label's, the access is read-only, and person is whichever member is using it.
   */
  lens: boolean;
  /** In a band account: a member's own login (not the band's shared one), who changes only their own details. */
  ownLogin?: boolean;
  /**
   * In a label-made band account: which books it's looking at, the label's for the band (the lens)
   * or its own (orgId is the band account's own). Unset in every other account.
   */
  books?: "label" | "own";
};

export type ViewingAs = {
  kind: "band" | "person";
  /** The band's or person's name. */
  name: string;
  /** The label account it's viewed from. */
  label: Account;
  /** Who's really signed in. */
  realUser: Context["user"];
  /** Where "stop viewing" goes back to. */
  back: string;
};

/**
 * The signed-in session, or null. If the browser sends two session cookies (a stale copy next to the
 * current one, see src/lib/auth-cookies.ts), each is tried on its own, so the stale one can't sign
 * them out.
 */
export const getSession = cache(async () => {
  const h = await headers();
  const tokens = cookieValues(h.get("cookie"), SESSION_TOKEN);
  if (tokens.length <= 1) return auth.api.getSession({ headers: h });
  for (const t of tokens) {
    const only = new Headers(h);
    only.set("cookie", `${t.name}=${t.value}`);
    const session = await auth.api.getSession({ headers: only, query: { disableCookieCache: true } });
    if (session) return session;
  }
  return null;
});

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
 * yet to /welcome to create one. While a label admin is viewing as a band or a person, it's theirs
 * instead, and nothing can be changed: server actions are refused.
 *
 * A label-made band account sees the label's books narrowed to its band (bandLens), in pages and
 * in actions alike (an action re-draws the page it came from). The lens only lets it change its
 * orders, and stock counts through requireAccess's bandMay; its own settings and logins go through
 * accountContext / requireAdmin. It keeps its own books too (made on its first visit): switched to
 * them (BOOKS_COOKIE), it's its own account instead, like a band that runs its own (ownBooksContext).
 * Its sales are always added and imported there (requireAccess).
 */
export const getContext = cache(async (): Promise<Context> => {
  let ctx = await accountContext();
  if (!ctx.managedBy) return ctx;
  if (!ctx.managedBy.ownBooks && !ctx.viewingAs) {
    await setOwnBooks(ctx.orgId, true);
    ctx = { ...ctx, managedBy: { ...ctx.managedBy, ownBooks: true } };
  }
  if (ctx.managedBy!.ownBooks && (await cookies()).get(BOOKS_COOKIE)?.value === ownBooksValue(ctx.orgId)) return ownBooksContext(ctx);
  return bandLens(ctx);
});

/** The cookie that says a label-made band account is looking at its own books: "<band account id>|own". */
export const BOOKS_COOKIE = "lm_books";

export function ownBooksValue(bandOrgId: string) {
  return `${bandOrgId}|own`;
}

/** What a member's own login may do in the band's own books: look, and send in receipts. */
const OWN_MEMBER_ACCESS = { sales: "view", payouts: "view", receipts: "view" } as const satisfies Access["permissions"];

/**
 * A label-made band account in its own books: its own orgId, as a band that runs its own account.
 * The band's shared login runs them; a member's own login only looks (and sends in receipts), as
 * their payee record there (kept in step with the label's, src/server/own-books.ts).
 */
async function ownBooksContext(ctx: Context): Promise<Context> {
  if (ctx.isAdmin) return { ...ctx, books: "own", ownLogin: false };
  const { fixed } = await bandLoginPerson(ctx);
  return {
    ...ctx,
    role: "member",
    isAdmin: false,
    access: { admin: false, permissions: { ...OWN_MEMBER_ACCESS }, bandAreas: [], bandIds: [] },
    memberType: null,
    books: "own",
    ownLogin: fixed,
  };
}

/** A label-made band account's own books, whichever books it's looking at. */
export async function ownBooksOf(ctx: Context): Promise<Context> {
  return ctx.books === "own" ? ctx : ownBooksContext(await accountContext());
}

/**
 * The account they're in, as itself: for a label-made band account, just that small account (its
 * settings, who signs in to it, which member is using it). Server actions always get this.
 */
export const accountContext = cache(async (): Promise<Context> => {
  const real = await realContext();
  const view = await viewAsContext(real);
  if (!view) return real;
  if ((await headers()).get("next-action")) {
    throw new Error(`You’re viewing as ${view.viewingAs!.name}, so nothing can be changed. Stop viewing to make changes.`);
  }
  return view;
});

/**
 * What a band account sees of the label's books: its own band's part. It changes what isn't about
 * money: its orders, inventory, catalog and people. Not the band itself (saveBand), and nothing that
 * moves money: splits and costs need "rules", and the catalog fields sales are matched by (Bandcamp
 * URL, ISRC, catalog number) stay the label's (saveRelease, saveTrack, addTracks).
 */
const LENS_ACCESS = {
  permissions: { sales: "view", orders: "edit", inventory: "edit", payouts: "view", funds: "view", receipts: "view", catalog: "edit", roster: "edit" },
  bandAreas: ["sales", "orders", "inventory", "receipts", "catalog", "roster"],
} as const satisfies { permissions: Access["permissions"]; bandAreas: Area[] };

/**
 * Who's using a label-made band account's login, as an id in the label's books: a member's own login
 * is always them (`fixed`); the band's shared login is the whole band (null).
 */
export const bandLoginPerson = cache(async (ctx: Context): Promise<{ personId: number | null; fixed: boolean }> => {
  const [own] = await db
    .select({ personId: schema.bandLoginPeople.personId })
    .from(schema.bandLoginPeople)
    .where(and(eq(schema.bandLoginPeople.orgId, ctx.orgId), eq(schema.bandLoginPeople.userId, ctx.user.id)));
  return own ? { personId: own.personId, fixed: true } : { personId: null, fixed: false };
});

async function bandLens(ctx: Context, extra: Access["permissions"] = {}): Promise<Context> {
  const m = ctx.managedBy!;
  // Whoever's using it, if they're still a current member of the band in the label's books.
  const { personId } = await bandLoginPerson(ctx);
  let person: Context["person"] = null;
  if (personId) {
    const [row] = await db
      .select({ person: schema.people })
      .from(schema.bandMemberships)
      .innerJoin(schema.people, eq(schema.people.id, schema.bandMemberships.personId))
      .where(
        and(
          eq(schema.bandMemberships.orgId, m.labelOrgId),
          eq(schema.bandMemberships.bandId, m.bandId),
          eq(schema.bandMemberships.personId, personId),
          eq(schema.bandMemberships.active, true),
        ),
      );
    person = row?.person ?? null;
  }
  return {
    ...ctx,
    orgId: m.labelOrgId,
    role: "member",
    isAdmin: false,
    access: { admin: false, permissions: { ...LENS_ACCESS.permissions, ...extra }, bandAreas: [...LENS_ACCESS.bandAreas], bandIds: [m.bandId] },
    memberType: null,
    person,
    lens: true,
    ownLogin: personId != null,
    books: "label",
  };
}

/** The signed-in person's own context, ignoring "view as". */
export const realContext = cache(async (): Promise<Context> => {
  const session = await getSession();
  if (!session) {
    // Which sign-in cookies came with a request that has no session (names and counts, never values).
    const raw = (await headers()).get("cookie") ?? "";
    const names = raw.split(";").map((c) => c.split("=")[0].trim()).filter((n) => n.includes("better-auth"));
    if (names.length) console.log(`signed-out request with auth cookies: ${names.join(", ")}`);
    redirect("/login");
  }
  const accounts = await accountsFor(session.user.id);
  if (accounts.length === 0) redirect("/welcome");
  const org = accounts.find((a) => a.id === session.session.activeOrganizationId) ?? accounts[0];
  const isAdmin = org.role !== "member";
  // Everything else at once: their payee record, their member type, whether a label manages this
  // account, their name as saved now (the session's copy is cached, so right after a change on
  // Account it would still have the old one), and (rarely) remembering the account.
  const [[person], type, managedBy, [saved]] = await Promise.all([
    db
      .select()
      .from(schema.people)
      .where(and(eq(schema.people.orgId, org.id), eq(schema.people.userId, session.user.id))),
    isAdmin ? null : memberTypeFor(org.id, session.user.id),
    org.kind === "band" ? managingLabel(org.id) : null,
    db.select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, session.user.id)),
    org.id !== session.session.activeOrganizationId
      ? // Remember it, so the next request doesn't have to guess.
        db.update(schema.session).set({ activeOrganizationId: org.id }).where(eq(schema.session.id, session.session.id))
      : null,
  ]);
  const { access, memberType } = await accessFrom(org.id, isAdmin, type, person?.id ?? null);
  return {
    user: { id: session.user.id, name: saved?.name ?? session.user.name, email: session.user.email },
    org,
    orgId: org.id,
    role: org.role,
    isAdmin,
    access,
    memberType,
    person: person ?? null,
    accounts,
    managedBy,
    viewingAs: null,
    lens: false,
  };
});

/** The cookie that says who a label admin is viewing as: "<label account id>|band|<band id>" or "…|person|<person id>". */
export const VIEW_AS_COOKIE = "lm_view_as";

export function viewAsValue(labelOrgId: string, kind: "band" | "person", id: number) {
  return `${labelOrgId}|${kind}|${id}`;
}

function parseViewAs(raw: string) {
  const [labelOrgId, kind, id] = raw.split("|");
  const n = Number(id);
  if (!labelOrgId || (kind !== "band" && kind !== "person") || !Number.isInteger(n) || n <= 0) return null;
  return { labelOrgId, kind, id: n } as const;
}

/**
 * The context of whoever the signed-in label admin is viewing as, checked afresh on every request:
 * they must still be an admin of the label, and the band's sub-account or the person must be its.
 */
async function viewAsContext(real: Context): Promise<Context | null> {
  const raw = (await cookies()).get(VIEW_AS_COOKIE)?.value;
  const target = raw ? parseViewAs(raw) : null;
  if (!target) return null;
  const label = real.accounts.find((a) => a.id === target.labelOrgId && a.kind === "label" && a.role !== "member");
  if (!label) return null;
  const viewing = (kind: "band" | "person", name: string, back: string): ViewingAs => ({ kind, name, label, realUser: real.user, back });

  if (target.kind === "band") {
    const [row] = await db
      .select({ link: schema.accountLinks, org: schema.organization, band: schema.bands, ownBooks: schema.accountSettings.ownBooks })
      .from(schema.accountLinks)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.accountLinks.bandOrgId))
      .innerJoin(schema.bands, eq(schema.bands.id, schema.accountLinks.labelBandId))
      .leftJoin(schema.accountSettings, eq(schema.accountSettings.orgId, schema.accountLinks.bandOrgId))
      .where(
        and(
          eq(schema.accountLinks.labelOrgId, label.id),
          eq(schema.accountLinks.labelBandId, target.id),
          eq(schema.accountLinks.managed, true),
          eq(schema.accountLinks.status, "active"),
        ),
      );
    if (!row) return null;
    // As the band's own admins see it.
    const org: Account = { id: row.org.id, name: row.org.name, slug: row.org.slug, kind: "band", role: "admin" };
    return {
      user: { id: real.user.id, name: row.band.name, email: "" },
      org,
      orgId: org.id,
      role: "admin",
      isAdmin: true,
      access: { admin: true, permissions: {}, bandAreas: [], bandIds: [] },
      memberType: null,
      person: null,
      accounts: [org],
      managedBy: { linkId: row.link.id, labelOrgId: label.id, labelName: label.name, bandId: row.band.id, ownBooks: !!row.ownBooks },
      viewingAs: viewing("band", row.band.name, `/bands/${row.band.id}`),
      lens: false,
    };
  }

  const [person] = await db
    .select()
    .from(schema.people)
    .where(and(eq(schema.people.orgId, label.id), eq(schema.people.id, target.id)));
  if (!person) return null;
  // As they'd see the label: an admin if their login is one, else a member with their member type.
  const [login] = person.userId
    ? await db
        .select({ role: schema.member.role })
        .from(schema.member)
        .where(and(eq(schema.member.organizationId, label.id), eq(schema.member.userId, person.userId)))
    : [];
  const role: Role = login && ["owner", "admin"].includes(login.role) ? (login.role as Role) : "member";
  const isAdmin = role !== "member";
  const type = !isAdmin && person.userId ? await memberTypeFor(label.id, person.userId) : null;
  const { access, memberType } = await accessFrom(label.id, isAdmin, type, person.id);
  const org: Account = { ...label, role };
  return {
    // Someone with no login yet gets a stand-in id, which matches nothing.
    user: { id: person.userId ?? `viewing-as-${person.id}`, name: person.name, email: person.email ?? "" },
    org,
    orgId: org.id,
    role,
    isAdmin,
    access,
    memberType,
    person,
    accounts: [org],
    managedBy: null,
    viewingAs: viewing("person", person.name, `/directory#p${person.id}`),
    lens: false,
  };
}

type MemberTypeRow = typeof schema.memberTypes.$inferSelect & { managedBandIds: number[] | null };

/** Their member type in an account, if they have one, with the bands they manage (if picked). */
async function memberTypeFor(orgId: string, userId: string): Promise<MemberTypeRow | null> {
  const [row] = await db
    .select({ type: schema.memberTypes, bandIds: schema.memberTypeAssignments.bandIds })
    .from(schema.memberTypeAssignments)
    .innerJoin(schema.memberTypes, eq(schema.memberTypes.id, schema.memberTypeAssignments.memberTypeId))
    .where(and(eq(schema.memberTypeAssignments.orgId, orgId), eq(schema.memberTypeAssignments.userId, userId)));
  return row ? { ...row.type, managedBandIds: row.bandIds } : null;
}

/**
 * What a member type grants. Sections limited to "their own bands" use the bands they manage, or,
 * if none were picked, the bands they're in (looked up only if a section is limited).
 */
async function accessFrom(orgId: string, isAdmin: boolean, type: MemberTypeRow | null, personId: number | null) {
  if (isAdmin) return { access: { admin: true, permissions: {}, bandAreas: [], bandIds: [] } satisfies Access, memberType: null };
  const bandAreas = normalizeBandAreas(type?.bandAreas);
  const memberOf = async () =>
    personId === null
      ? []
      : (
          await db
            .select({ bandId: schema.bandMemberships.bandId })
            .from(schema.bandMemberships)
            .where(and(eq(schema.bandMemberships.orgId, orgId), eq(schema.bandMemberships.personId, personId), eq(schema.bandMemberships.active, true)))
        ).map((r) => r.bandId);
  const bandIds = !bandAreas.length ? [] : (type?.managedBandIds ?? (await memberOf()));
  const access: Access = { admin: false, permissions: normalizePermissions(type?.permissions), bandAreas, bandIds };
  return { access, memberType: type?.name ?? null };
}

/** What someone can do in an account: everything for admins, else what their member type grants. */
export async function accessFor(orgId: string, userId: string, isAdmin: boolean, personId: number | null) {
  return accessFrom(orgId, isAdmin, isAdmin ? null : await memberTypeFor(orgId, userId), personId);
}

/**
 * For pages and actions in one section: anyone whose role or member type allows it (viewing, or
 * changing things). Everyone else is sent to their own earnings page.
 */
export async function requireAccess(
  area: Area,
  level: "view" | "edit" = "view",
  /** A band account may do this to its own band's part of the label's books (recounting stock, say). */
  { bandMay = false }: { bandMay?: boolean } = {},
): Promise<Context> {
  let ctx = await getContext();
  // A band login may do this one thing to its band's part of the label's books.
  if (ctx.lens && bandMay) ctx = { ...ctx, access: { ...ctx.access, permissions: { ...ctx.access.permissions, [area]: level } } };
  // A band account the label made adds and imports sales in its own books, whichever it's looking at.
  if (ctx.lens && area === "sales" && level === "edit") ctx = await ownBooksOf(ctx);
  if (!can(ctx.access, area, level)) redirect("/me");
  return ctx;
}

/** For pages and actions only admins may use (settings, who can sign in): members are sent to their own earnings page. */
export async function requireAdmin(): Promise<Context> {
  // Admin of the account itself: for a label-made band account, its own settings and logins.
  const ctx = await accountContext();
  if (!ctx.isAdmin) redirect("/me");
  return ctx;
}
