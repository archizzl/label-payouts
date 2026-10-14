import { SESSION_DATA, SESSION_TOKEN } from "@/lib/auth-cookies";

/**
 * Deletes the stale copies of the sign-in cookies that are scoped to just this host (no Domain).
 * The current ones, shared across labelmaker.ing and admin.labelmaker.ing, are untouched.
 */
export async function POST() {
  const headers = new Headers({ "cache-control": "no-store" });
  for (const name of [SESSION_TOKEN, SESSION_DATA]) {
    headers.append("set-cookie", `__Secure-${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
    headers.append("set-cookie", `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  }
  return new Response(null, { status: 204, headers });
}
