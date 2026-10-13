/*
 * Features still being built, switched on per account from the admin dashboard (and per site
 * admin, for themselves). To add one: list it here and check it with featureOn() where it shows.
 */

export const FEATURE_FLAGS = [
  {
    key: "projects",
    label: "Projects",
    description: "Albums, tours and other projects: what each cost and what its releases made back. Also the project picker on receipts.",
  },
] as const;

export type FeatureFlag = (typeof FEATURE_FLAGS)[number]["key"];

export const isFeatureFlag = (s: string): s is FeatureFlag => FEATURE_FLAGS.some((f) => f.key === s);

/**
 * Whether someone sees a feature: their own choice if they've made one (site admins, on the admin
 * dashboard), else on if their current account has been given it, and on for site admins.
 */
export function featureVisible({ pref, accountHasIt, siteAdmin }: { pref: boolean | null; accountHasIt: boolean; siteAdmin: boolean }) {
  if (pref !== null) return pref;
  return accountHasIt || siteAdmin;
}
