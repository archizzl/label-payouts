import { eq } from "drizzle-orm";
import Link from "next/link";
import { SplitRules } from "@/components/split-rules";
import { buttonClass } from "@/components/ui";
import { schema } from "@/db";
import { personOptionsFor, type RuleWithShares, rulesWhere } from "@/server/data";

type Item = { id: number; title: string; bandId: number; kind: string };

/**
 * Splits of one item's own (a release or merch item), on a splits page beside the band's and label's:
 * every item that has one, and any other picked from the list to give it one. The same splits as on
 * the item's catalog page.
 */
export async function ItemSplits({
  orgId,
  items,
  picked,
  path,
  keep,
  bandName,
  readOnly = false,
}: {
  /** Whose books the items and their splits are in. */
  orgId: string;
  items: Item[];
  /** An item picked to give a split (from the URL's "item"). */
  picked: number | null;
  /** The page's address, and its other URL parameters, kept when picking. */
  path: string;
  keep: Record<string, string>;
  /** Shown beside each item when there are several bands. */
  bandName?: (id: number) => string | undefined;
  readOnly?: boolean;
}) {
  const ids = new Set(items.map((i) => i.id));
  const rules = (await rulesWhere(orgId, eq(schema.splitRules.scope, "release"))).filter((r) => r.releaseId !== null && ids.has(r.releaseId));
  const byItem = new Map<number, RuleWithShares[]>();
  for (const r of rules) byItem.set(r.releaseId!, [...(byItem.get(r.releaseId!) ?? []), r]);
  const shown = items.filter((i) => byItem.has(i.id) || i.id === picked).sort((a, b) => a.title.localeCompare(b.title));
  const rest = items.filter((i) => !byItem.has(i.id) && i.id !== picked).sort((a, b) => a.title.localeCompare(b.title));
  // Who can be given a share: each band's people.
  const people = new Map(await Promise.all([...new Set(shown.map((i) => i.bandId))].map(async (b) => [b, await personOptionsFor(orgId, b)] as const)));

  return (
    <div className="space-y-3">
      {shown.length === 0 ? (
        <p className="text-sm text-muted">No item has a split of its own.</p>
      ) : (
        <div className="divide-y divide-border border-b border-border">
          {shown.map((i) => (
            <div key={i.id} id={`item-${i.id}`} className="scroll-mt-4 py-3">
              <h3 className="mb-2 text-sm font-medium">
                <Link href={`/catalog/${i.id}`}>{i.title}</Link>
                {bandName && <span className="font-normal text-muted"> · {bandName(i.bandId)}</span>}
              </h3>
              <SplitRules
                rules={byItem.get(i.id) ?? []}
                people={people.get(i.bandId) ?? []}
                scope={{ scope: "release", releaseId: i.id }}
                emptyText=""
                readOnly={readOnly}
              />
            </div>
          ))}
        </div>
      )}
      {!readOnly && rest.length > 0 && (
        // Picking one shows it above, ready for a split.
        <form method="get" action={`${path}#item-splits`} className="flex flex-wrap items-center gap-2">
          {Object.entries(keep).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <select name="item" required defaultValue="" aria-label="Item" className="!w-auto max-w-full !py-1 text-sm">
            <option value="" disabled>
              Choose an item
            </option>
            {rest.map((i) => (
              <option key={i.id} value={i.id}>
                {i.title}
                {i.kind === "merch" ? " (merch)" : ""}
                {bandName ? ` · ${bandName(i.bandId)}` : ""}
              </option>
            ))}
          </select>
          <button type="submit" className={buttonClass("secondary", "sm")}>
            + split an item
          </button>
        </form>
      )}
    </div>
  );
}
