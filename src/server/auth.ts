import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins";
import { APIError } from "better-auth/api";
import { db, schema } from "@/db";
import { checkSignup, consumeInvite } from "./signup-invites";

/**
 * Logins (Better Auth). Email + password to start. Each label or band is an "organization"
 * (shown in the app as an account), with a `kind` of "label" or "band". Members have a role:
 * owner and admin manage everything; member sees their own money and their band's totals.
 */
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  baseURL: process.env.BETTER_AUTH_URL,
  trustedOrigins: process.env.BETTER_AUTH_URL ? [process.env.BETTER_AUTH_URL] : undefined,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    // There's no email service: a site admin makes the reset link on /admin and sends it themselves.
    sendResetPassword: async ({ user, url }) => {
      resetLinks.set(user.email.toLowerCase(), url);
    },
    resetPasswordTokenExpiresIn: 60 * 60 * 24,
    revokeSessionsOnPasswordReset: true,
  },
  // Signing up is by invitation only, whichever route a sign-up comes through.
  databaseHooks: {
    user: {
      create: {
        before: async (user, ctx) => {
          const check = await checkSignup(user.email, inviteCodeFrom(ctx));
          if (!check.ok) throw new APIError("FORBIDDEN", { message: check.reason });
        },
        after: async (user, ctx) => {
          const code = inviteCodeFrom(ctx);
          if (code) await consumeInvite(code, user.id);
        },
      },
    },
  },
  // Slow down password guessing. Kept in the database, so every server shares the count.
  rateLimit: {
    enabled: process.env.NODE_ENV === "production",
    storage: "database",
    window: 60,
    max: 100,
    customRules: { "/sign-in/email": { window: 60, max: 5 }, "/sign-up/email": { window: 60, max: 5 }, "/request-password-reset": { window: 60, max: 3 } },
  },
  plugins: [
    organization({
      schema: {
        organization: {
          additionalFields: { kind: { type: "string", required: true, defaultValue: "label", input: true } },
        },
        // Which payee record an invite is for, so accepting it links their login to that person.
        invitation: {
          additionalFields: { personId: { type: "number", required: false, input: true } },
        },
      },
      // No email service yet: admins copy the invite link from the Members page and send it themselves.
      sendInvitationEmail: async () => {},
      invitationExpiresIn: 60 * 60 * 24 * 14,
    }),
    // Lets server actions set the session cookie (sign in / sign up from a form).
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;

/** The invite code a sign-up came with (sent in the x-invite-code header by the sign-up form). */
function inviteCodeFrom(ctx: { headers?: Headers } | null) {
  return ctx?.headers?.get("x-invite-code")?.trim() || null;
}

/** Reset links Better Auth made, waiting for the admin page to pick them up (see makeResetLink). */
const resetLinks = ((globalThis as unknown as { resetLinks?: Map<string, string> }).resetLinks ??= new Map());

/** A one-time link for someone to choose a new password (valid 24 hours), for a site admin to send them. */
export async function makeResetLink(email: string) {
  const key = email.toLowerCase();
  resetLinks.delete(key);
  await auth.api.requestPasswordReset({ body: { email, redirectTo: "/reset-password" } });
  const url = resetLinks.get(key) ?? null;
  resetLinks.delete(key);
  return url;
}
