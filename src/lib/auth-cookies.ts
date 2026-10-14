/*
 * Sign-in cookies. Since the session cookie became shared with admin.labelmaker.ing (domain
 * cookies), a browser can still hold an older copy scoped to just labelmaker.ing. It then sends two
 * cookies with the same name, and the stale one can win: the person looks signed out.
 */

/** Better Auth's cookies (with or without the __Secure- prefix it uses on https). */
export const SESSION_TOKEN = "better-auth.session_token";
export const SESSION_DATA = "better-auth.session_data";

/** Every value sent for a cookie, in order, from a Cookie header ("__Secure-" prefix or not). */
export function cookieValues(header: string | null, name: string): { name: string; value: string }[] {
  if (!header) return [];
  return header
    .split(";")
    .map((part) => {
      const i = part.indexOf("=");
      return i === -1 ? null : { name: part.slice(0, i).trim(), value: part.slice(i + 1).trim() };
    })
    .filter((c): c is { name: string; value: string } => !!c && (c.name === name || c.name === `__Secure-${name}`));
}

/** More than one session token: the browser is holding a stale copy alongside the current one. */
export const hasDuplicateSession = (header: string | null) => cookieValues(header, SESSION_TOKEN).length > 1;
