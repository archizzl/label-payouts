import "server-only";
import { notFound, redirect } from "next/navigation";
import { getSession } from "./context";

/*
 * Site admins run the whole site (invites, everyone's logins). Who they are is set by the
 * SITE_ADMIN_EMAILS setting (comma-separated), not stored in the database.
 */

export function isSiteAdminEmail(email: string | null | undefined) {
  if (!email) return false;
  const admins = (process.env.SITE_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(email.trim().toLowerCase());
}

/** For the admin pages and actions: anyone else gets "not found". */
export async function requireSiteAdmin() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!isSiteAdminEmail(session.user.email)) notFound();
  return session;
}
