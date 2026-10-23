/*
 * Features still being built, switched on from the admin dashboard: for groups, for accounts, or
 * for kinds of account (and per site admin, for themselves). To add one: list it here and check it
 * with featureOn() where it shows.
 */

export const FEATURE_FLAGS = [
  {
    key: "projects",
    label: "Projects",
    description: "Albums, tours and other projects: what each cost and what its releases made back. Also the project picker on receipts.",
  },
  {
    key: "abel",
    label: "Abel",
    description: "Abel, the assistant: answers questions about the group's money, sales and orders, and makes changes once you confirm them.",
  },
] as const;

export type FeatureFlag = (typeof FEATURE_FLAGS)[number]["key"];

export const isFeatureFlag = (s: string): s is FeatureFlag => FEATURE_FLAGS.some((f) => f.key === s);

/** Kinds of account a feature can be given to everywhere, by their role in the group they're in. */
export const FLAG_AUDIENCES = [
  { key: "everyone", label: "Everyone" },
  { key: "admins", label: "Owners and admins" },
  { key: "members", label: "Members" },
  { key: "labels", label: "Everyone in a label group" },
  { key: "bands", label: "Everyone in a band group" },
] as const;

export type FlagAudience = (typeof FLAG_AUDIENCES)[number]["key"];

export const isFlagAudience = (s: string): s is FlagAudience => FLAG_AUDIENCES.some((a) => a.key === s);

/** Whether someone, with this role in a group of this kind, is in an audience. */
export function inAudience(audience: string, { role, kind }: { role: "owner" | "admin" | "member"; kind: "label" | "band" }) {
  switch (audience) {
    case "everyone":
      return true;
    case "admins":
      return role !== "member";
    case "members":
      return role === "member";
    case "labels":
      return kind === "label";
    case "bands":
      return kind === "band";
    default:
      return false;
  }
}

/**
 * Whether someone sees a feature: their own choice if they've made one (site admins, on the admin
 * dashboard), else on if they've been given it (their group, their account or their kind of
 * account), and on for site admins.
 */
export function featureVisible({ pref, granted, siteAdmin }: { pref: boolean | null; granted: boolean; siteAdmin: boolean }) {
  if (pref !== null) return pref;
  return granted || siteAdmin;
}
