/*
 * Member types: what someone who isn't an admin can see and change. Admins and owners can do
 * everything; a plain member (no type) sees only their own earnings. A member type grants more,
 * section by section: nothing, view, or view and change. Some sections can be limited to the bands
 * the person plays in (e.g. a band's manager sees and ships just that band's orders).
 */

export const AREAS = [
  { key: "dashboard", label: "Dashboard", hint: "The overview: who's owed what, recent sales, charts.", edit: false, bands: false },
  { key: "sales", label: "Sales", hint: "Browsing sales; changing means importing and matching them.", edit: true, bands: true },
  { key: "orders", label: "Orders", hint: "Open merch orders; changing means marking them shipped.", edit: true, bands: true },
  { key: "payouts", label: "Payouts", hint: "Payout periods and statements; changing means making and paying them.", edit: true, bands: false },
  { key: "funds", label: "Label funds", hint: "What the label holds and has sent on.", edit: true, bands: false },
  { key: "receipts", label: "Receipts", hint: "Everyone's receipts; changing means approving and reimbursing.", edit: true, bands: false },
  { key: "catalog", label: "Catalog", hint: "Releases, tracks and merch.", edit: true, bands: false },
  { key: "roster", label: "Bands & people", hint: "Bands, their members, and payees' details.", edit: true, bands: false },
  { key: "rules", label: "Rules", hint: "How money is split and what's withheld.", edit: true, bands: false },
  { key: "fans", label: "Fans", hint: "The email list.", edit: true, bands: false },
] as const;

export type Area = (typeof AREAS)[number]["key"];
export type Level = "none" | "view" | "edit";
export type Permissions = Partial<Record<Area, "view" | "edit">>;

const RANK: Record<Level, number> = { none: 0, view: 1, edit: 2 };
const isArea = (k: string): k is Area => AREAS.some((a) => a.key === k);

/** Clean up saved or submitted permissions: known sections only, and no "edit" where there's nothing to change. */
export function normalizePermissions(raw: unknown): Permissions {
  const out: Permissions = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isArea(k) || (v !== "view" && v !== "edit")) continue;
    const area = AREAS.find((a) => a.key === k)!;
    out[k] = v === "edit" && !area.edit ? "view" : v;
  }
  return out;
}

/** Sections limited to the person's own bands: only those where that's possible. */
export function normalizeBandAreas(raw: unknown): Area[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((k): k is Area => typeof k === "string" && isArea(k) && AREAS.find((a) => a.key === k)!.bands))];
}

/** What someone can do in an account. */
export type Access = {
  /** Owner or admin: everything, everywhere. */
  admin: boolean;
  permissions: Permissions;
  /** Sections they see only for their own bands. */
  bandAreas: Area[];
  /** The bands they play in (for those sections). */
  bandIds: number[];
};

export const levelOf = (access: Access, area: Area): Level => (access.admin ? "edit" : (access.permissions[area] ?? "none"));

export const can = (access: Access, area: Area, level: Exclude<Level, "none"> = "view") => RANK[levelOf(access, area)] >= RANK[level];

/** The bands they're limited to in this section, or null for all of them. */
export const bandScope = (access: Access, area: Area): number[] | null =>
  !access.admin && access.bandAreas.includes(area) ? access.bandIds : null;

/** "Sales: view (own bands) · Orders: change (own bands)" */
export function describePermissions(permissions: Permissions, bandAreas: Area[]): string {
  const parts = AREAS.filter((a) => permissions[a.key]).map(
    (a) => `${a.label}: ${permissions[a.key] === "edit" ? "change" : "view"}${bandAreas.includes(a.key) ? " (own bands)" : ""}`,
  );
  return parts.length ? parts.join(" · ") : "Only their own earnings";
}

/** Something belonging to these bands is within the scope (null: no limit). */
export const inBandScope = (scope: number[] | null, bandIds: (number | null)[]) =>
  scope === null || bandIds.some((b) => b !== null && scope.includes(b));
