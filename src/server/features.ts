import "server-only";
import { notFound } from "next/navigation";
import { getContext } from "./context";
import { isSiteAdminEmail } from "./site-admin";

/*
 * Features still being built: on only for site admins (SITE_ADMIN_EMAILS), hidden from everyone
 * else. To release one, make its check return true.
 */

/** Projects (albums, tours…: what each cost and made back), and picking a project on receipts. */
export async function projectsEnabled(): Promise<boolean> {
  const { user } = await getContext();
  return isSiteAdminEmail(user.email);
}

/** For Projects' own pages and actions: anyone without the feature gets "not found". */
export async function requireProjects() {
  if (!(await projectsEnabled())) notFound();
}
