import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins";
import { db, schema } from "@/db";

/**
 * Logins (Better Auth). Email + password to start. Each label or band is an "organization"
 * (shown in the app as an account), with a `kind` of "label" or "band". Members have a role:
 * owner and admin manage everything; member sees their own money and their band's totals.
 */
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: { enabled: true, minPasswordLength: 8 },
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
