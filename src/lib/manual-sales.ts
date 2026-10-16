/*
 * Sales added by hand: money from shows, or merch sold in person, that never went through Bandcamp.
 * They're stored like any other sale (so splits, payouts and charts count them), under one import
 * per account, with their band chosen when they're added rather than matched.
 */

/** The import every account's hand-added sales hang off (left out of the import history). */
export const MANUAL_IMPORT = "Added by hand";

/** How a hand-added sale is marked as routed (re-matching leaves it alone). */
export const MANUAL_VIA = "manual";

/** Where it came from, in the sales list's "From" column. */
export const MANUAL_SOURCE = "In person";

/** What it was: a show (door money or a fee), merch, or anything else. */
export const MANUAL_KINDS = [
  { value: "show", label: "Show", category: "other", itemType: "show" },
  { value: "merch", label: "Merch", category: "merch", itemType: "package" },
  { value: "other", label: "Other", category: "other", itemType: "other" },
] as const;

export type ManualKind = (typeof MANUAL_KINDS)[number]["value"];
