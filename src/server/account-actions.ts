"use server";

import { and, eq, isNull, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import { slugify } from "@/lib/slug";
import { auth } from "./auth";
import { accountContext, accountsFor, type Context, getSession, requireAdmin, VIEW_AS_COOKIE } from "./context";
import { labelReachNote } from "./own-books";
import { AREAS, type Area, normalizeBandAreas, normalizePermissions } from "@/lib/permissions";
import { assignMemberType, memberTypeForInvite, parseRoleChoice, setInviteMemberType, setManagedBands } from "./member-types";
import { applyMyDetails, normalizeEmail } from "./people";
import { deleteAccountsWithBooks, soleAccounts } from "./account-deletion";
import { ownBand, reRouteAll } from "./data";
import { renameSubAccount } from "./band-accounts";
import { bandcampPattern } from "@/lib/routing";
import { cleanCashtag, cleanVenmoHandle } from "@/lib/paypal-export";
import { bandcampCredentials, forgetBandcampSignIn, myBands } from "./bandcamp-api";
import { encryptSecret } from "./secrets";
import { photoFrom } from "./merch-photos";
import { clearOldPhotos, removeProfilePhoto, setProfilePhoto } from "./profile-photos";

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
    return { error: messageOf(e, "Couldn't create your account.") };
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
    if (!org) return { error: "Couldn't create the group." };
    orgId = org.id;
  } catch (e) {
    return { error: messageOf(e, "Couldn't create the group.") };
  }
  // A band account is its band. Whoever made it isn't assumed to be in it: setup asks.
  if (kind === "band") await db.insert(schema.bands).values({ orgId, name });
  await auth.api.setActiveOrganization({ body: { organizationId: orgId }, headers: await headers() });
  revalidatePath("/", "layout");
  redirect("/welcome/setup");
}

/** Setting up a new account, step 1: where it is (Bandcamp, Spotify, Apple Music). Then: are you in it? */
export async function saveSetupLinks(_: FormState, fd: FormData): Promise<FormState> {
  const { orgId } = await requireAdmin();
  const values = {
    bandcampUrl: str(fd, "bandcampUrl").slice(0, 300) || null,
    spotifyUrl: str(fd, "spotifyUrl").slice(0, 300) || null,
    appleMusicUrl: str(fd, "appleMusicUrl").slice(0, 300) || null,
  };
  await db.insert(schema.accountSettings).values({ orgId, ...values }).onConflictDoUpdate({ target: schema.accountSettings.orgId, set: values });
  redirect("/welcome/setup?step=you");
}

/**
 * Setting up a new account, step 2: whether whoever made it is in it (a member of the band, or
 * someone the label pays). If so, they're added with their details, linked to their login, and
 * those details are saved everywhere else they're someone too.
 */
export async function saveSetupMe(_: FormState, fd: FormData): Promise<FormState> {
  const ctx = await requireAdmin();
  const { orgId, user } = ctx;
  const done = ctx.org.kind === "band" ? "/directory" : "/";
  if (str(fd, "inIt") !== "yes") redirect(done);
  const name = str(fd, "name").slice(0, 120);
  if (!name) return { error: "Enter your name." };
  const opt = (k: string) => str(fd, k).slice(0, 200) || null;
  const details = {
    name,
    email: opt("email"),
    paypalMe: opt("paypalMe"),
    venmo: cleanVenmoHandle(str(fd, "venmo")) || null,
    cashtag: cleanCashtag(str(fd, "cashtag")) || null,
  };
  // Already here (going back through setup): just their details.
  const [already] = await db
    .select({ id: schema.people.id })
    .from(schema.people)
    .where(and(eq(schema.people.orgId, orgId), eq(schema.people.userId, user.id)));
  if (!already) {
    const [me] = await db.insert(schema.people).values({ orgId, userId: user.id, ...details }).returning({ id: schema.people.id });
    const band = ctx.org.kind === "band" ? await ownBand(orgId) : null;
    if (band) {
      const role = str(fd, "role");
      await db.insert(schema.bandMemberships).values({ orgId, bandId: band.id, personId: me.id, roles: role ? [role] : [] });
    }
  }
  await applyMyDetails(user.id, details);
  if (name !== user.name) await auth.api.updateUser({ body: { name }, headers: await headers() });
  revalidatePath("/", "layout");
  redirect(done);
}

/** Work in another of your accounts. */
export async function switchAccount(fd: FormData) {
  const session = await getSession();
  if (!session) redirect("/login");
  const orgId = str(fd, "orgId");
  if (!(await accountsFor(session.user.id)).some((a) => a.id === orgId)) throw new Error("You're not in that group.");
  (await cookies()).delete(VIEW_AS_COOKIE);
  await auth.api.setActiveOrganization({ body: { organizationId: orgId }, headers: await headers() });
  revalidatePath("/", "layout");
  redirect("/");
}

export async function saveAccountSettings(_: FormState, fd: FormData): Promise<FormState> {
  const { orgId, managedBy } = await requireAdmin();
  // A band account the label made: its name is the label's to change, and Bandcamp is only for its own books.
  const name = managedBy ? "" : str(fd, "name");
  if (name) await db.update(schema.organization).set({ name }).where(eq(schema.organization.id, orgId));
  const error = await writeAccountSettings(orgId, managedBy, fd);
  if (error) return { error };
  revalidatePath("/", "layout");
  return { ok: "Saved" };
}

/**
 * An account's links and Bandcamp API access, from whichever of those fields the form has (a field
 * the form doesn't have stays as it is). An error message if the API access can't be used.
 */
async function writeAccountSettings(orgId: string, managedBy: Context["managedBy"], fd: FormData): Promise<string | null> {
  const values: Partial<typeof schema.accountSettings.$inferInsert> = {};
  if (fd.has("bandcampUrl")) values.bandcampUrl = str(fd, "bandcampUrl") || null;
  if (fd.has("spotifyUrl")) values.spotifyUrl = str(fd, "spotifyUrl") || null;
  if (fd.has("appleMusicUrl")) values.appleMusicUrl = str(fd, "appleMusicUrl") || null;
  let changedAccess = false;
  if (fd.has("bandcampClientId")) {
    const clientId = str(fd, "bandcampClientId") || null;
    // Bandcamp allows one sign-in per API client: two accounts sharing one would keep signing each other out.
    if (clientId) {
      const [other] = await db
        .select({ orgId: schema.accountSettings.orgId })
        .from(schema.accountSettings)
        .where(and(eq(schema.accountSettings.bandcampClientId, clientId), ne(schema.accountSettings.orgId, orgId)))
        .limit(1);
      if (other) {
        return other.orgId === managedBy?.labelOrgId
          ? `That’s ${managedBy.labelName}’s Bandcamp API access. Your own books need the band’s own client ID from Bandcamp.`
          : "That Bandcamp API access is already used by another group.";
      }
    }
    const secret = str(fd, "bandcampClientSecret");
    // New API access means the saved Bandcamp sign-in belongs to the old one: forget it.
    const [before] = await db.select().from(schema.accountSettings).where(eq(schema.accountSettings.orgId, orgId));
    changedAccess = !!before && (before.bandcampClientId !== clientId || !!secret);
    values.bandcampClientId = clientId;
    // Blank keeps the saved secret; clearing the client ID removes both.
    if (secret) values.bandcampClientSecret = encryptSecret(secret);
    if (!clientId) values.bandcampClientSecret = null;
  }
  if (!Object.keys(values).length) return null;
  await db
    .insert(schema.accountSettings)
    .values({ orgId, ...values })
    .onConflictDoUpdate({ target: schema.accountSettings.orgId, set: values });
  if (changedAccess) await forgetBandcampSignIn(orgId);
  return null;
}

/**
 * A band account's Settings, one form: the band (its name and other spellings, kept on its record in
 * the books it's in: its own, or the label's for a band account the label made), where it is
 * (Bandcamp, which is also how its sales are matched to it, Spotify, Apple Music), and Bandcamp API
 * access for its own books.
 */
export async function saveBandSettings(_: FormState, fd: FormData): Promise<FormState> {
  const ctx = await requireAdmin();
  if (ctx.org.kind !== "band") return { error: "This is for a band." };
  const m = ctx.managedBy;
  // The books its band is in, and which band.
  const booksId = m ? m.labelOrgId : ctx.orgId;
  const bandId = m ? m.bandId : (await ownBand(ctx.orgId))?.id;
  if (!bandId) return { error: "This group has no band." };
  const [band] = await db.select().from(schema.bands).where(and(eq(schema.bands.orgId, booksId), eq(schema.bands.id, bandId)));
  if (!band) return { error: "This group has no band." };
  const name = str(fd, "name").slice(0, 200);
  if (!name) return { error: "Enter the band’s name." };
  const aliases = str(fd, "aliases").split(",").map((a) => a.trim()).filter(Boolean);
  // Renamed: the old name stays another spelling, so sales still find it.
  if (band.name !== name && !aliases.includes(band.name)) aliases.push(band.name);
  // Its Bandcamp address is also how its sales are matched to it (in place of the old address's).
  const [before] = await db.select({ url: schema.accountSettings.bandcampUrl }).from(schema.accountSettings).where(eq(schema.accountSettings.orgId, ctx.orgId));
  const oldPattern = bandcampPattern(before?.url ?? null);
  const newPattern = bandcampPattern(str(fd, "bandcampUrl") || null);
  const urlPatterns = [...band.urlPatterns.filter((p) => p !== oldPattern && p !== newPattern), ...(newPattern ? [newPattern] : [])];
  const error = await writeAccountSettings(ctx.orgId, m, fd);
  if (error) return { error };
  await db.update(schema.bands).set({ name, aliases, urlPatterns }).where(eq(schema.bands.id, band.id));
  if (m) await renameSubAccount(booksId, bandId, name);
  else await db.update(schema.organization).set({ name }).where(eq(schema.organization.id, ctx.orgId));
  await reRouteAll(booksId);
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
    // A band's own books: the Bandcamp bands the label's API access reaches come in through the label.
    const note = await labelReachNote(orgId);
    return { ok: `Connected. This API access reaches ${names}.${note ? ` ${note}` : ""}` };
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
    if (!p) return { error: "That person isn't in this group." };
    if (p.userId) return { error: `${p.name} already has an account linked.` };
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
  if (!account) return { error: "You’re not in that group any more. Reload this page." };
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
  // The accounts only you run go with your login: the same ones the page named, or nothing happens.
  const sole = await soleAccounts(user.id);
  const named = str(fd, "alsoDelete").split(",").filter(Boolean).sort();
  if (named.join(",") !== sole.map((a) => a.id).sort().join(",")) {
    return { error: "Your groups have changed since this page opened. Reload it and try again." };
  }
  await deleteAccountsWithBooks(sole.map((a) => a.id));
  // Signed out first (so the browser's sign-in cookies go too), then the login itself: its sessions
  // and own preferences go with it, and links from the books are cleared.
  (await cookies()).delete(VIEW_AS_COOKIE);
  await auth.api.signOut({ headers: await headers() });
  await clearOldPhotos(user.id, null);
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
  if (str(fd, "orgId") !== orgId) return { error: "You’ve switched groups since. Reload this page and try again." };
  if (ctx.managedBy || !ctx.isAdmin) return { error: "Only an admin of this group can delete it." };
  if (str(fd, "name").toLowerCase() !== ctx.org.name.trim().toLowerCase()) return { error: `Type ${ctx.org.name} exactly to confirm.` };
  await deleteAccountsWithBooks([orgId]);
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
/** Your own profile photo (Account): upload one, replacing any before, or take it off. */
export async function saveMyPhoto(_: FormState, fd: FormData): Promise<FormState> {
  const session = await getSession();
  if (!session) redirect("/login");
  // (Not while viewing as someone else.)
  await accountContext();
  try {
    if (str(fd, "remove") === "1") {
      await removeProfilePhoto(session.user.id);
      revalidatePath("/", "layout");
      return { ok: "Photo removed." };
    }
    const file = photoFrom(fd);
    if (!file) return { error: "Choose a photo." };
    await setProfilePhoto(session.user.id, file);
  } catch (e) {
    return { error: (e as Error).message };
  }
  revalidatePath("/", "layout");
  return { ok: "Photo saved." };
}

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

