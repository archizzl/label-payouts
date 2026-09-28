import Link from "next/link";
import type { deductions as deductionsTable, releases as releasesTable } from "@/db/schema";
import { formatMatches } from "@/lib/splits";
import { ItemCosts } from "./item-cost";

type Release = typeof releasesTable.$inferSelect;
type Deduction = typeof deductionsTable.$inferSelect;

/** When given, each format shows the per-item costs aimed at it and a "+ cost" button. */
export type Costs = {
  deductions: Deduction[];
  people: { id: number; name: string }[];
  names: { person: Map<number, string> };
};

/**
 * Per-item costs that apply to this format: ones aimed at it, and broader ones (band- or label-wide,
 * or for its release) whose format words match it. Mirrors how the split engine applies them.
 */
export function costsFor(deductions: Deduction[], release: Release, pkg: Release["packages"][number]) {
  return deductions.filter((d) => {
    if (d.kind !== "per_unit") return false;
    if (d.packageId != null) return d.packageId === pkg.bandcampId;
    if (d.releaseId != null && d.releaseId !== release.id) return false;
    if (d.itemCategory != null && d.itemCategory !== "merch") return false;
    return !d.formatMatch || formatMatches(d.formatMatch, [pkg.title, pkg.typeName].filter(Boolean).join(" "));
  });
}

/** Every physical format (CD, vinyl, cassette…) of the given releases, one row each. */
export function physicalFormats(releases: Release[]) {
  return releases
    .filter((r) => r.kind !== "merch")
    .flatMap((r) => r.packages.map((p) => ({ release: r, format: p })))
    .sort(
      (a, b) =>
        (b.release.releaseDate ?? "").localeCompare(a.release.releaseDate ?? "") ||
        a.release.title.localeCompare(b.release.title) ||
        a.format.title.localeCompare(b.format.title),
    );
}

export function PhysicalFormatsTable({ releases, empty, costs }: { releases: Release[]; empty?: string; costs?: Costs }) {
  const rows = physicalFormats(releases);
  if (rows.length === 0) return <p className="text-sm text-muted">{empty ?? "No physical formats."}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="data">
        <thead>
          <tr>
            <th>format</th>
            <th>release</th>
            <th>type</th>
            <th>SKU</th>
            <th className="num">price</th>
            {costs && <th>per-item cost</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ release: r, format: p }) => (
            <tr key={`${r.id}-${p.bandcampId}`}>
              <td>
                <div className="flex items-center gap-2.5">
                  {r.artUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={r.artUrl.replace(/_(10|16)\.jpg$/, "_3.jpg")}
                      alt=""
                      loading="lazy"
                      className="h-6 w-6 shrink-0 border border-border bg-surface-2 object-cover"
                    />
                  ) : (
                    <span className="h-6 w-6 shrink-0 bg-surface-2" />
                  )}
                  <span>{p.title}</span>
                </div>
              </td>
              <td>
                <Link href={`/catalog/${r.id}`}>{r.title}</Link>
              </td>
              <td className="text-muted">{p.typeName ?? "—"}</td>
              <td className="whitespace-nowrap">{p.sku ?? "—"}</td>
              <td className="num">{p.price != null ? `${p.price.toFixed(2)} ${p.currency ?? ""}` : "—"}</td>
              {costs && (
                <td>
                  <ItemCosts
                    costs={costsFor(costs.deductions, r, p)}
                    releaseId={r.id}
                    packageId={p.bandcampId}
                    currency={p.currency ?? "USD"}
                    people={costs.people}
                    personName={costs.names.person}
                  />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
