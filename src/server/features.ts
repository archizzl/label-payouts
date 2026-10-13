import "server-only";
import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { cache } from "react";
import { db, schema } from "@/db";
import { type FeatureFlag, featureVisible } from "@/lib/feature-flags";
import { getContext } from "./context";
import { isSiteAdminEmail } from "./site-admin";

/*
 * Features still being built (src/lib/feature-flags.ts): on for the accounts given them on the
 * admin dashboard, and for site admins unless they've hidden them for themselves.
 */

/** Whether the person viewing sees this feature, in the account they're working in. Once per request. */
export const featureOn = cache(async (flag: FeatureFlag): Promise<boolean> => {
  const { user, orgId } = await getContext();
  const [[pref], [granted]] = await Promise.all([
    db
      .select({ enabled: schema.featureFlagPrefs.enabled })
      .from(schema.featureFlagPrefs)
      .where(and(eq(schema.featureFlagPrefs.flag, flag), eq(schema.featureFlagPrefs.userId, user.id))),
    db
      .select({ id: schema.featureFlagAccounts.id })
      .from(schema.featureFlagAccounts)
      .where(and(eq(schema.featureFlagAccounts.flag, flag), eq(schema.featureFlagAccounts.orgId, orgId))),
  ]);
  return featureVisible({ pref: pref?.enabled ?? null, accountHasIt: !!granted, siteAdmin: isSiteAdminEmail(user.email) });
});

/** Projects (albums, tours…: what each cost and made back), and picking a project on receipts. */
export const projectsEnabled = () => featureOn("projects");

/** For Projects' own pages and actions: anyone without the feature gets "not found". */
export async function requireProjects() {
  if (!(await projectsEnabled())) notFound();
}
