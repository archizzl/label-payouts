/*
 * Switching groups keeps you in the section you were in (Sales, say), when the other group has it.
 * A page for one thing (a band, a payout) belongs to the group you left, so it's that section's list.
 */

/** Sections every group has. A page you may not see sends you to your own earnings. */
const EVERY_GROUP = ["sales", "orders", "inventory", "periods", "receipts", "catalog", "directory", "settings", "account", "me"];

/** Sections only a label has. */
const LABEL_ONLY = ["funds", "rules"];

/** A band's or a person's page: the Directory lists them. */
const IN_DIRECTORY = ["bands", "people"];

/** Where to land in the group switched to, from the page you were on. */
export function sectionAfterSwitch(from: string, kind: "label" | "band"): string {
  const section = from.split(/[?#]/)[0].split("/")[1] ?? "";
  if (EVERY_GROUP.includes(section)) return `/${section}`;
  if (LABEL_ONLY.includes(section)) return kind === "label" ? `/${section}` : "/";
  if (IN_DIRECTORY.includes(section)) return "/directory";
  return "/";
}
