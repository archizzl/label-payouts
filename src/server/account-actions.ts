"use server";

import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import { slugify } from "@/lib/slug";
import { auth } from "./auth";
import { accountContext, accountsFor, BOOKS_COOKIE, getSession, ownBooksValue, realContext, requireAdmin, VIEW_AS_COOKIE } from "./context";
import { bothBooksWarning, setOwnBooks, syncOwnPeople } from "./own-books";
import { AREAS, type Area, normalizeBandAreas, normalizePermissions } from "@/lib/permissions";
import { assignMemberType, memberTypeForInvite, parseRoleChoice, setInviteMemberType, setManagedBands } from "./member-types";
import { applyMyDetails, normalizeEmail } from "./people";
import { cleanCashtag, cleanVenmoHandle } from "@/lib/paypal-export";
import { bandcampCredentials, forgetBandcampSignIn, myBands } from "./bandcamp-api";
import { encryptSecret } from "./secrets";
import { discardStoredFiles } from "./receipt-store";

/*
 * Logins and accounts: signing up and in, creating a label or band account, switching between
 * accounts, inviting people, and account settings.
 */

export type FormState = { error?: string; ok?: string } | null;

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** Only same-site paths are allowed as a "next" destination. */
function safeNext(next: string) {
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

/** Better Auth reports problems as errors with a readable message. */
function messageOf(e: unknown, fallback: string) {
  const m = (e as { body?: { message?: string }; message?: string })?.body?.message ?? (e as Error)?.message;
  return m && !m.startsWith("NEXT_") ? m : fallback;
}

// ---------- sign up / in / out ----------

export async function signUp(_: FormState, fd: FormData): Promise<FormState> {
  const name = str(fd, "name");
  const email = str(fd, "email").toLowerCase();
  const password = String(fd.get("password") ?? "");
  if (!name || !email) return { error: "Enter your name and email." };
  if (password.length < 8) return { error: "Use a password of at least 8 characters." };
  try {
    // The invite code goes along so Better Auth's check (src/server/auth.ts) lets this sign-up through.
    const h = new Headers(await headers());
    const code = str(fd, "code");
    if (code) h.set("x-invite-code", code);
    await auth.api.signUpEmail({ body: { name, email, password }, headers: h });
  } catch (e) {
    return { error: messageOf(e, "Couldn't create your login.") };
  }
  redirect(safeNext(str(fd, "next") || "/welcome"));
}

export async function signIn(_: FormState, fd: FormData): Promise<FormState> {
  const email = str(fd, "email").toLowerCase();
  const password = String(fd.get("password") ?? "");
  try {
    await auth.api.signInEmail({ body: { email, password }, headers: await headers() });
  } catch (e) {
    return { error: messageOf(e, "That email and password don't match.") };
  }
  redirect(safeNext(str(fd, "next")));
}

/** Set a new password from a reset link, then sign in with it. */
export async function resetPassword(_: FormState, fd: FormData): Promise<FormState> {
  const password = String(fd.get("password") ?? "");
  if (password.length < 8) return { error: "Use a password of at least 8 characters." };
  try {
    await auth.api.resetPassword({ body: { newPassword: password, token: str(fd, "token") } });
  } catch (e) {
    return { error: messageOf(e, "This reset link doesn’t work any more. Ask for a new one.") };
  }
  redirect("/login?reset=1");
}

/** Sign out, then to sign-in (or back to a same-site page, `next`, such as an invite link). */
export async function signOut(fd?: FormData) {
  (await cookies()).delete(VIEW_AS_COOKIE);
  await auth.api.signOut({ headers: await headers() });
  const next = fd ? str(fd, "next") : "";
  redirect(next ? safeNext(next) : "/login");
}

// ---------- accounts ----------


/**
 * A new label or band account, owned by whoever creates it. A band account gets its band straight
 * away; the creator is added as a payee (and, for a band, as a member of it) linked to their login.
 */
export async function createAccount(_: FormState, fd: FormData): Promise<FormState> {
  const session = await getSession();
  if (!session) redirect("/login");
  const name = str(fd, "name");
  const kind = str(fd, "kind") === "band" ? "band" : "label";
  if (!name) return { error: `Give your ${kind} a name.` };
  let orgId: string;
  try {
    const org = await auth.api.createOrganization({ body: { name, slug: slugify(name), kind }, headers: await headers() });
    if (!org) return { error: "Couldn't create the account." };
    orgId = org.id;
  } catch (e) {
    return { error: messageOf(e, "Couldn't create the account.") };
  }
  const [me] = await db
    .insert(schema.people)
    .values({ orgId, userId: session.user.id, name: session.user.name, email: session.user.email })
    .returning();
  if (kind === "band") {
    const [band] = await db.insert(schema.bands).values({ orgId, name }).returning();
    await db.insert(schema.bandMemberships).values({ orgId, bandId: band.id, personId: me.id });
  }
  await auth.api.setActiveOrganization({ body: { organizationId: orgId }, headers: await headers() });
  revalidatePath("/", "layout");
  redirect(kind === "band" ? "/directory" : "/");
}

/** Work in another of your accounts. */
export async function switchAccount(fd: FormData) {
  const session = await getSession();
  if (!session) redirect("/login");
  const orgId = str(fd, "orgId");
  if (!(await accountsFor(session.user.id)).some((a) => a.id === orgId)) throw new Error("You're not a member of that account.");
  (await cookies()).delete(VIEW_AS_COOKIE);
  await auth.api.setActiveOrganization({ body: { organizationId: orgId }, headers: await headers() });
  revalidatePath("/", "layout");
  redirect("/");
}

export async function saveAccountSettings(_: FormState, fd: FormData): Promise<FormState> {
  const { orgId, managedBy } = await requireAdmin();
  // A band account the label made: its name is the label's to change, and Bandcamp is only for its own books.
  if (managedBy && !managedBy.ownBooks) return { error: "Turn on own books first." };
  const name = managedBy ? "" : str(fd, "name");
  if (name) await db.update(schema.organization).set({ name }).where(eq(schema.organization.id, orgId));
  const clientId = str(fd, "bandcampClientId") || null;
  // Bandcamp allows one sign-in per API client: two accounts sharing one would keep signing each other out.
  if (clientId) {
    const [other] = await db
      .select({ orgId: schema.accountSettings.orgId })
      .from(schema.accountSettings)
      .where(and(eq(schema.accountSettings.bandcampClientId, clientId), ne(schema.accountSettings.orgId, orgId)))
      .limit(1);
    if (other) {
      return {
        error:
          other.orgId === managedBy?.labelOrgId
            ? `That’s ${managedBy.labelName}’s Bandcamp API access. Your own books need the band’s own client ID from Bandcamp.`
            : "That Bandcamp API access is already used by another account.",
      };
    }
  }
  const secret = str(fd, "bandcampClientSecret");
  // New API access means the saved Bandcamp sign-in belongs to the old one: forget it.
  const [before] = await db.select().from(schema.accountSettings).where(eq(schema.accountSettings.orgId, orgId));
  const changedAccess = !!before && (before.bandcampClientId !== clientId || !!secret);
  const values = {
    bandcampUrl: str(fd, "bandcampUrl") || null,
    bandcampClientId: clientId,
    // Blank keeps the saved secret; clearing the client ID removes both.
    ...(secret ? { bandcampClientSecret: encryptSecret(secret) } : {}),
    ...(clientId ? {} : { bandcampClientSecret: null }),
  };
  await db
    .insert(schema.accountSettings)
    .values({ orgId, ...values })
    .onConflictDoUpdate({ target: schema.accountSettings.orgId, set: values });
  if (changedAccess) await forgetBandcampSignIn(orgId);
  revalidatePath("/", "layout");
  return { ok: "Saved" };
}

/** Settings → "Test connection": sign in to Bandcamp and list the accounts the API reaches. */
export async function testBandcampConnection(): Promise<FormState> {
  const { orgId } = await requireAdmin();
  const creds = await bandcampCredentials(orgId);
  if (!creds) return { error: "Add the client ID and secret first." };
  try {
    const bands = await myBands(orgId, creds);
    revalidatePath("/settings");
    if (!bands.length) return { error: "Connected, but this API access doesn't reach any Bandcamp accounts." };
    const names = bands.map((b) => (b.member_bands?.length ? `${b.name} (with ${b.member_bands.length} artists)` : b.name)).join(", ");
    // A band's own books: warn if the label's API access reaches the same Bandcamp band.
    const warning = await bothBooksWarning(orgId);
    if (warning) return { error: `Connected to ${names}. ${warning}` };
    return { ok: `Connected. This API access reaches ${names}.` };
  } catch (e) {
    return { error: messageOf(e, "Couldn't reach Bandcamp.") };
  }
}

// ---------- members & invites ----------

/**
 * Invite someone to this account by email. There's no email service yet: the invite link is shown
 * on the Members page to copy and send. `personId` links the invite to their payee record.
 */
export async function inviteMember(_: FormState, fd: FormData): Promise<FormState> {
  const { orgId } = await requireAdmin();
  const email = normalizeEmail(str(fd, "email"));
  let choice;
  try {
    choice = await parseRoleChoice(orgId, str(fd, "role"));
  } catch (e) {
    return { error: (e as Error).message };
  }
  const { role } = choice;
  const personId = Number(str(fd, "personId")) || undefined;
  if (!email.includes("@")) return { error: "Enter their email address." };
  if (personId) {
    const [p] = await db
      .select()
      .from(schema.people)
      .where(and(eq(schema.people.orgId, orgId), eq(schema.people.id, personId)));
    if (!p) return { error: "That person isn't in this account." };
    if (p.userId) return { error: `${p.name} already has a login linked.` };
  }
  try {
    const invite = await auth.api.createInvitation({ body: { email, role, organizationId: orgId, personId }, headers: await headers() });
    if (choice.memberTypeId !== null && invite?.id) await setInviteMemberType(invite.id, choice.memberTypeId);
  } catch (e) {
    return { error: messageOf(e, "Couldn't create the invite.") };
  }
  revalidatePath("/directory");
  revalidatePath("/settings");
  return { ok: `Invited ${email}.` };
}

export async function cancelInvite(fd: FormData) {
  await requireAdmin();
  await auth.api.cancelInvitation({ body: { invitationId: str(fd, "id") }, headers: await headers() });
  revalidatePath("/directory");
  revalidatePath("/settings");
}

/** Change what someone can do here: admin, a plain member, or a member with a member type. */
export async function setMemberRole(fd: FormData) {
  const { orgId } = await requireAdmin();
  const memberId = str(fd, "memberId");
  const [m] = await db
    .select()
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.id, memberId)));
  if (!m || m.role === "owner") return;
  const { role, memberTypeId } = await parseRoleChoice(orgId, str(fd, "role"));
  if (m.role !== role) await auth.api.updateMemberRole({ body: { memberId, role, organizationId: orgId }, headers: await headers() });
  await assignMemberType(orgId, m.userId, memberTypeId);
  revalidatePath("/", "layout");
}

/**
 * The bands someone with a band-limited member type looks after: the ones picked (a manager), or
 * ("member") the bands they play in.
 */
export async function saveManagedBands(fd: FormData) {
  const { orgId } = await requireAdmin();
  const userId = str(fd, "userId");
  const ids = fd.getAll("bandId").map(Number).filter(Number.isInteger);
  const owned = ids.length
    ? (await db.select({ id: schema.bands.id }).from(schema.bands).where(eq(schema.bands.orgId, orgId))).map((b) => b.id).filter((id) => ids.includes(id))
    : [];
  await setManagedBands(orgId, userId, str(fd, "mode") === "picked" ? owned : null);
  revalidatePath("/", "layout");
}

/** Create or change a member type: its name, and what it can see and change. */
export async function saveMemberType(_: FormState, fd: FormData): Promise<FormState> {
  const { orgId } = await requireAdmin();
  const name = str(fd, "name").slice(0, 60);
  if (!name) return { error: "Give it a name." };
  const permissions = normalizePermissions(Object.fromEntries(AREAS.map((a) => [a.key, str(fd, `perm:${a.key}`)])));
  // "Only their own bands" counts only where they can see the section at all.
  const bandAreas = normalizeBandAreas(AREAS.filter((a) => fd.get(`bands:${a.key}`) === "on" && permissions[a.key]).map((a): Area => a.key));
  const id = Number(str(fd, "id")) || null;
  const existing = await db.select().from(schema.memberTypes).where(eq(schema.memberTypes.orgId, orgId));
  if (existing.some((t) => t.id !== id && t.name.trim().toLowerCase() === name.toLowerCase())) {
    return { error: `There’s already a member type called ${name}.` };
  }
  if (id) {
    const updated = await db
      .update(schema.memberTypes)
      .set({ name, permissions, bandAreas })
      .where(and(eq(schema.memberTypes.orgId, orgId), eq(schema.memberTypes.id, id)))
      .returning({ id: schema.memberTypes.id });
    if (!updated.length) return { error: "That member type doesn't exist any more." };
  } else {
    await db.insert(schema.memberTypes).values({ orgId, name, permissions, bandAreas });
  }
  revalidatePath("/", "layout");
  return { ok: id ? `Saved ${name}.` : `Added ${name}. Choose it for someone under Directory → Who can sign in.` };
}

/** Delete a member type. Anyone who had it goes back to seeing just their own earnings. */
export async function deleteMemberType(fd: FormData) {
  const { orgId } = await requireAdmin();
  await db.delete(schema.memberTypes).where(and(eq(schema.memberTypes.orgId, orgId), eq(schema.memberTypes.id, Number(str(fd, "id")))));
  revalidatePath("/", "layout");
}

export async function removeAccountMember(fd: FormData) {
  const { orgId } = await requireAdmin();
  const memberId = str(fd, "memberId");
  const [m] = await db
    .select()
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.id, memberId)));
  if (!m) return;
  await auth.api.removeMember({ body: { memberIdOrEmail: memberId, organizationId: orgId }, headers: await headers() });
  await assignMemberType(orgId, m.userId, null);
  // They keep their payee record (and history); it's just no longer tied to a login here.
  await db
    .update(schema.people)
    .set({ userId: null })
    .where(and(eq(schema.people.orgId, orgId), eq(schema.people.userId, m.userId)));
  revalidatePath("/directory");
  revalidatePath("/settings");
}

/** Accept an invite as the signed-in user, and link their login to their payee record. */
export async function acceptInvite(_: FormState, fd: FormData): Promise<FormState> {
  const session = await getSession();
  const id = str(fd, "id");
  if (!session) redirect(`/login?next=/invite/${id}`);
  const [invite] = await db.select().from(schema.invitation).where(eq(schema.invitation.id, id));
  if (!invite) return { error: "This invite doesn't exist any more." };
  try {
    await auth.api.acceptInvitation({ body: { invitationId: id }, headers: await headers() });
  } catch (e) {
    return { error: messageOf(e, "Couldn't accept the invite.") };
  }
  const orgId = invite.organizationId;
  const { user } = session;
  // Their payee record: the one the invite named, else one with their email, else a new one.
  const [named] = invite.personId
    ? await db
        .select()
        .from(schema.people)
        .where(and(eq(schema.people.orgId, orgId), eq(schema.people.id, invite.personId), isNull(schema.people.userId)))
    : [];
  const byEmail = named
    ? undefined
    : (await db.select().from(schema.people).where(and(eq(schema.people.orgId, orgId), isNull(schema.people.userId)))).find(
        (p) => normalizeEmail(p.email) === normalizeEmail(user.email),
      );
  const person = named ?? byEmail;
  if (person) {
    await db
      .update(schema.people)
      .set({ userId: user.id, email: person.email ?? user.email })
      .where(eq(schema.people.id, person.id));
  } else {
    await db.insert(schema.people).values({ orgId, userId: user.id, name: user.name, email: user.email });
  }
  // The member type the invite gave, if any.
  const memberTypeId = invite.role === "member" ? await memberTypeForInvite(orgId, invite.id) : null;
  if (memberTypeId !== null) await assignMemberType(orgId, user.id, memberTypeId);
  await auth.api.setActiveOrganization({ body: { organizationId: orgId }, headers: await headers() });
  revalidatePath("/", "layout");
  redirect("/");
}

/** Link your login to a payee record in this account (admins, for themselves). */
export async function linkMyself(fd: FormData) {
  const ctx = await requireAdmin();
  const personId = Number(str(fd, "personId"));
  await db
    .update(schema.people)
    .set({ userId: null })
    .where(and(eq(schema.people.orgId, ctx.orgId), eq(schema.people.userId, ctx.user.id)));
  if (personId) {
    await db
      .update(schema.people)
      .set({ userId: ctx.user.id })
      .where(and(eq(schema.people.orgId, ctx.orgId), eq(schema.people.id, personId), isNull(schema.people.userId)));
  }
  revalidatePath("/", "layout");
}

/**
 * Leave one of your accounts (from Account): your login stops being one of its logins, and nothing
 * in its books changes (your payee record stays, just no longer linked to your login). A label's
 * only admin can't leave it with nobody to run it; a band account the label made can always be
 * left, since the label manages it. Leaving the account you're in moves you on to another.
 */
export async function leaveAccount(_: FormState, fd: FormData): Promise<FormState> {
  const session = await getSession();
  if (!session) redirect("/login");
  const { user } = session;
  const orgId = str(fd, "orgId");
  const account = (await accountsFor(user.id)).find((a) => a.id === orgId);
  if (!account) return { error: "You’re not in that account any more. Reload this page." };
  const [link] = await db
    .select({ id: schema.accountLinks.id })
    .from(schema.accountLinks)
    .where(and(eq(schema.accountLinks.bandOrgId, orgId), eq(schema.accountLinks.managed, true), eq(schema.accountLinks.status, "active")));
  if (!link && account.role !== "member") {
    const others = await db
      .select({ role: schema.member.role })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, orgId), ne(schema.member.userId, user.id)));
    if (!others.some((m) => m.role === "owner" || m.role === "admin")) {
      return { error: `You’re the only admin of ${account.name}. Make someone else an admin there first.` };
    }
  }
  await db.delete(schema.member).where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, user.id)));
  await db.delete(schema.bandLoginPeople).where(and(eq(schema.bandLoginPeople.orgId, orgId), eq(schema.bandLoginPeople.userId, user.id)));
  await db.update(schema.people).set({ userId: null }).where(and(eq(schema.people.orgId, orgId), eq(schema.people.userId, user.id)));
  const [next] = await accountsFor(user.id);
  if (!next) redirect("/welcome");
  if (session.session.activeOrganizationId === orgId) {
    (await cookies()).delete(VIEW_AS_COOKIE);
    await auth.api.setActiveOrganization({ body: { organizationId: next.id }, headers: await headers() });
  }
  revalidatePath("/", "layout");
  return { ok: `You’ve left ${account.name}.` };
}

/**
 * Delete your login everywhere: it's taken out of every account and can't sign in again. Nothing in
 * any account's books is deleted (payee records, payouts and receipts stay, just no longer linked
 * to a login). Refused while you're the only admin of a label, or of a band that runs its own
 * account, so nothing is left with nobody to run it. You type your email to confirm.
 */
export async function deleteMyLogin(_: FormState, fd: FormData): Promise<FormState> {
  const session = await getSession();
  if (!session) redirect("/login");
  const { user } = session;
  if (normalizeEmail(str(fd, "email")) !== normalizeEmail(user.email)) return { error: "Type your email exactly to confirm." };
  const accounts = await accountsFor(user.id);
  // Band accounts a label made are the label's to run.
  const managed = new Set(
    (
      await db
        .select({ orgId: schema.accountLinks.bandOrgId })
        .from(schema.accountLinks)
        .where(and(eq(schema.accountLinks.managed, true), eq(schema.accountLinks.status, "active")))
    ).map((r) => r.orgId),
  );
  for (const a of accounts) {
    if (managed.has(a.id) || a.role === "member") continue;
    const others = await db
      .select({ role: schema.member.role })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, a.id), ne(schema.member.userId, user.id)));
    if (!others.some((m) => m.role === "owner" || m.role === "admin")) {
      return { error: `You’re the only admin of ${a.name}. Make someone else an admin there first.` };
    }
  }
  // Signed out first (so the browser's sign-in cookies go too), then the login itself: its sessions
  // and own preferences go with it, and links from the books are cleared.
  (await cookies()).delete(VIEW_AS_COOKIE);
  await auth.api.signOut({ headers: await headers() });
  await db.delete(schema.user).where(eq(schema.user.id, user.id));
  redirect("/login");
}

/**
 * Delete the account you run (a label, or a band that runs its own account) and everything in it:
 * its books, its people, its receipts and their files, and the band accounts it made for its bands.
 * Labels or bands linked to it just lose the link. Logins aren't deleted, only taken out of it. An
 * admin types the account's name to confirm.
 */
export async function deleteAccount(_: FormState, fd: FormData): Promise<FormState> {
  const ctx = await accountContext();
  const { orgId, user } = ctx;
  if (str(fd, "orgId") !== orgId) return { error: "You’ve switched accounts since. Reload this page and try again." };
  if (ctx.managedBy || !ctx.isAdmin) return { error: "Only an admin of this account can delete it." };
  if (str(fd, "name").toLowerCase() !== ctx.org.name.trim().toLowerCase()) return { error: `Type ${ctx.org.name} exactly to confirm.` };
  // The band accounts it made go with it (they only show its books).
  const made = (
    await db
      .select({ orgId: schema.accountLinks.bandOrgId })
      .from(schema.accountLinks)
      .where(and(eq(schema.accountLinks.labelOrgId, orgId), eq(schema.accountLinks.managed, true)))
  )
    .map((r) => r.orgId)
    .filter((id): id is string => !!id);
  const orgIds = [orgId, ...made];
  const files = await db
    .select({ storageKey: schema.expenseFiles.storageKey })
    .from(schema.expenseFiles)
    .innerJoin(schema.expenses, eq(schema.expenses.id, schema.expenseFiles.expenseId))
    .where(inArray(schema.expenses.orgId, orgIds));
  // Everything in an account goes with it (every table's account reference cascades).
  await db.delete(schema.organization).where(inArray(schema.organization.id, orgIds));
  await discardStoredFiles(files);
  (await cookies()).delete(VIEW_AS_COOKIE);
  const [next] = await accountsFor(user.id);
  if (next) await auth.api.setActiveOrganization({ body: { organizationId: next.id }, headers: await headers() });
  revalidatePath("/", "layout");
  redirect(next ? "/" : "/welcome");
}

/**
 * Your details, everywhere at once: your login's name (top right) and, on every payee record that's
 * yours (see myPeople), the same name and how you're paid.
 */
export async function saveMyDetails(_: FormState, fd: FormData): Promise<FormState> {
  const session = await getSession();
  if (!session) redirect("/login");
  const name = str(fd, "name").slice(0, 120);
  if (!name) return { error: "Enter your name." };
  // Through Better Auth, so the cached session cookie has the new name too.
  await auth.api.updateUser({ body: { name }, headers: await headers() });
  if (fd.has("email")) {
    const opt = (k: string) => str(fd, k).slice(0, 200) || null;
    await applyMyDetails(session.user.id, {
      name,
      email: opt("email"),
      paypalMe: opt("paypalMe"),
      venmo: cleanVenmoHandle(str(fd, "venmo")) || null,
      cashtag: cleanCashtag(str(fd, "cashtag")) || null,
    });
  }
  revalidatePath("/", "layout");
  return { ok: "Saved." };
}

/** A new password for your login (your other sign-ins stay signed in). */
export async function changeMyPassword(_: FormState, fd: FormData): Promise<FormState> {
  const session = await getSession();
  if (!session) redirect("/login");
  const newPassword = String(fd.get("newPassword") ?? "");
  if (newPassword.length < 8) return { error: "Use a password of at least 8 characters." };
  try {
    await auth.api.changePassword({ body: { currentPassword: String(fd.get("currentPassword") ?? ""), newPassword }, headers: await headers() });
  } catch {
    return { error: "Your current password isn’t right." };
  }
  return { ok: "Password changed." };
}

// ---------- a label-made band account's own books ----------

/** Settings: a band account the label made turns its own books on or off (off hides them; nothing is deleted). */
export async function setOwnBooksAction(fd: FormData) {
  const ctx = await requireAdmin();
  if (!ctx.managedBy) throw new Error("Only a band account a label made can turn on its own books.");
  const on = fd.get("on") === "1";
  await setOwnBooks(ctx.orgId, on);
  const jar = await cookies();
  if (on) jar.set(BOOKS_COOKIE, ownBooksValue(ctx.orgId), BOOKS_COOKIE_OPTIONS);
  else jar.delete(BOOKS_COOKIE);
  revalidatePath("/", "layout");
}

const BOOKS_COOKIE_OPTIONS = { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 400 * 24 * 60 * 60 } as const;

/**
 * The switch at the top of Sales, Payouts, Receipts and the dashboard: the label's books for the band,
 * or the band's own. The cookie only counts for the account it names, with own books on (getContext),
 * so it also works for a label admin viewing as the band.
 */
export async function switchBooks(fd: FormData) {
  const orgId = str(fd, "orgId");
  const own = fd.get("books") === "own";
  const jar = await cookies();
  if (own && orgId) {
    jar.set(BOOKS_COOKIE, ownBooksValue(orgId), BOOKS_COOKIE_OPTIONS);
    // Whoever joined the band in the label's books since: in its own books too.
    const real = await realContext();
    if (real.orgId === orgId && real.managedBy?.ownBooks) await syncOwnPeople(orgId);
  } else jar.delete(BOOKS_COOKIE);
  revalidatePath("/", "layout");
  redirect(safeNext(str(fd, own ? "back_own" : "back_label")));
}
