"use server";

import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import { auth } from "./auth";
import { accountsFor, getSession, requireAdmin } from "./context";
import { normalizeEmail } from "./people";
import { bandcampCredentials, forgetBandcampSignIn, myBands } from "./bandcamp-api";
import { encryptSecret } from "./secrets";

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

export async function signOut() {
  await auth.api.signOut({ headers: await headers() });
  redirect("/login");
}

// ---------- accounts ----------

function slugify(name: string) {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${base || "account"}-${randomBytes(3).toString("hex")}`;
}

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
  redirect(kind === "band" ? "/bands" : "/");
}

/** Work in another of your accounts. */
export async function switchAccount(fd: FormData) {
  const session = await getSession();
  if (!session) redirect("/login");
  const orgId = str(fd, "orgId");
  if (!(await accountsFor(session.user.id)).some((a) => a.id === orgId)) throw new Error("You're not a member of that account.");
  await auth.api.setActiveOrganization({ body: { organizationId: orgId }, headers: await headers() });
  revalidatePath("/", "layout");
  redirect("/");
}

export async function saveAccountSettings(_: FormState, fd: FormData): Promise<FormState> {
  const { orgId } = await requireAdmin();
  const name = str(fd, "name");
  if (name) await db.update(schema.organization).set({ name }).where(eq(schema.organization.id, orgId));
  const clientId = str(fd, "bandcampClientId") || null;
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
    revalidatePath("/account");
    if (!bands.length) return { error: "Connected, but this API access doesn't reach any Bandcamp accounts." };
    const names = bands.map((b) => (b.member_bands?.length ? `${b.name} (with ${b.member_bands.length} artists)` : b.name)).join(", ");
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
  const role = str(fd, "role") === "admin" ? "admin" : "member";
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
    await auth.api.createInvitation({ body: { email, role, organizationId: orgId, personId }, headers: await headers() });
  } catch (e) {
    return { error: messageOf(e, "Couldn't create the invite.") };
  }
  revalidatePath("/account");
  return { ok: `Invited ${email}. Copy their invite link below and send it to them.` };
}

export async function cancelInvite(fd: FormData) {
  await requireAdmin();
  await auth.api.cancelInvitation({ body: { invitationId: str(fd, "id") }, headers: await headers() });
  revalidatePath("/account");
}

export async function setMemberRole(fd: FormData) {
  const { orgId } = await requireAdmin();
  const role = str(fd, "role") === "admin" ? "admin" : "member";
  await auth.api.updateMemberRole({ body: { memberId: str(fd, "memberId"), role, organizationId: orgId }, headers: await headers() });
  revalidatePath("/account");
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
  // They keep their payee record (and history); it's just no longer tied to a login here.
  await db
    .update(schema.people)
    .set({ userId: null })
    .where(and(eq(schema.people.orgId, orgId), eq(schema.people.userId, m.userId)));
  revalidatePath("/account");
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
