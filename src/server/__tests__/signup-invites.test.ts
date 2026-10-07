import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { newAccount, testDb } from "../../../test/helpers/db";

let db: Awaited<ReturnType<typeof testDb>>["db"];
let schema: Awaited<ReturnType<typeof testDb>>["schema"];
let auth: typeof import("../auth");
let invites: typeof import("../signup-invites");

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret";
  ({ db, schema } = await testDb());
  auth = await import("../auth");
  invites = await import("../signup-invites");
});

const email = () => `${randomUUID().slice(0, 8)}@example.test`;
/** Sign up straight through Better Auth's API (as the form, or anyone calling the API, would). */
const signUp = (address: string, code?: string) =>
  auth.auth.api.signUpEmail({
    body: { name: "Test", email: address, password: "a-long-password" },
    headers: new Headers(code ? { "x-invite-code": code } : {}),
  });
const exists = async (address: string) => (await db.select().from(schema.user).where(eq(schema.user.email, address))).length > 0;

describe("signing up is by invitation only", () => {
  it("refuses a sign-up without an invite, even straight through the API", async () => {
    const a = email();
    await expect(signUp(a)).rejects.toThrow(/invitation only/);
    expect(await exists(a)).toBe(false);
  });

  it("lets an invite create one login, then it's used up", async () => {
    const invite = await invites.createInvite({ days: 14, createdBy: null });
    const a = email();
    await signUp(a, invite.code);
    expect(await exists(a)).toBe(true);
    const [row] = await db.select().from(schema.signupInvites).where(eq(schema.signupInvites.id, invite.id));
    expect(row.usedAt).toBeTruthy();
    const b = email();
    await expect(signUp(b, invite.code)).rejects.toThrow(/used, revoked or has expired/);
    expect(await exists(b)).toBe(false);
  });

  it("refuses revoked, expired, made-up and wrong-email invites", async () => {
    const revoked = await invites.createInvite({ days: 14, createdBy: null });
    await invites.revokeInvite(revoked.id);
    await expect(signUp(email(), revoked.code)).rejects.toThrow(/used, revoked or has expired/);

    const expired = await invites.createInvite({ days: 14, createdBy: null });
    await db.update(schema.signupInvites).set({ expiresAt: "2020-01-01 00:00:00" }).where(eq(schema.signupInvites.id, expired.id));
    await expect(signUp(email(), expired.code)).rejects.toThrow(/used, revoked or has expired/);

    await expect(signUp(email(), "made-up-code-1234")).rejects.toThrow(/used, revoked or has expired/);

    const locked = await invites.createInvite({ email: "Only.Me@Example.test", days: 14, createdBy: null });
    await expect(signUp(email(), locked.code)).rejects.toThrow(/only.me@example.test/);
    await signUp("only.me@example.test", locked.code);
    expect(await exists("only.me@example.test")).toBe(true);
  });

  it("still lets someone invited into an existing account create a login for that email", async () => {
    const orgId = await newAccount();
    const inviterId = randomUUID();
    await db.insert(schema.user).values({ id: inviterId, name: "Admin", email: `${inviterId}@example.test`, emailVerified: false, createdAt: new Date(), updatedAt: new Date() });
    const a = email();
    await db.insert(schema.invitation).values({
      id: randomUUID(), organizationId: orgId, email: a, role: "member", status: "pending", inviterId,
      expiresAt: new Date(Date.now() + 86_400_000), createdAt: new Date(),
    });
    await signUp(a);
    expect(await exists(a)).toBe(true);
  });

  it("makes a one-time reset link a site admin can send", async () => {
    const invite = await invites.createInvite({ days: 1, createdBy: null });
    const a = email();
    await signUp(a, invite.code);
    const link = await auth.makeResetLink(a);
    expect(link).toMatch(/reset-password/);
  });
});

describe("site admins", () => {
  it("are whoever SITE_ADMIN_EMAILS names, ignoring case and spaces", async () => {
    const { isSiteAdminEmail } = await import("../site-admin");
    process.env.SITE_ADMIN_EMAILS = " Boss@Example.test , other@example.test";
    expect(isSiteAdminEmail("boss@example.test")).toBe(true);
    expect(isSiteAdminEmail("OTHER@example.test")).toBe(true);
    expect(isSiteAdminEmail("member@example.test")).toBe(false);
    expect(isSiteAdminEmail(null)).toBe(false);
    process.env.SITE_ADMIN_EMAILS = "";
    expect(isSiteAdminEmail("boss@example.test")).toBe(false);
  });
});
