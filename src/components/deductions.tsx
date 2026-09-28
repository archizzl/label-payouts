import type { deductions as deductionsTable } from "@/db/schema";
import { ITEM_CATEGORIES } from "@/lib/bandcamp-csv";
import { formatCents } from "@/lib/money";
import { deleteDeduction } from "@/server/actions";
import { DeductionForm, type ReleaseOption } from "./deduction-form";
import { SubmitButton } from "./client";
import { Badge, Disclosure } from "./ui";

type Deduction = typeof deductionsTable.$inferSelect;
type Option = { id: number; name: string };


const DEST_LABEL = { label: "Kept by label", band_fund: "Band fund", expense: "Withheld for costs", person: "Paid to" } as const;

type Names = {
  band: Map<number, string>;
  release: Map<number, string>;
  person?: Map<number, string>;
  /** Bandcamp package id → "Release — Format" */
  format?: Map<number, string>;
};

export function describeDeduction(d: Deduction, names: Names) {
  const money = formatCents(d.amountCents ?? 0, d.currency ?? "USD");
  const amount =
    d.kind === "percent"
      ? `${((d.percentBps ?? 0) / 100).toFixed(2).replace(/\.00$/, "")}%`
      : d.kind === "per_unit"
        ? `${money} per item`
        : `${money} recoupable`;
  const destination =
    d.destination === "person" ? `Paid to ${d.personId ? (names.person?.get(d.personId) ?? "someone") : "someone"}` : DEST_LABEL[d.destination];
  const scope = [
    d.bandId ? names.band.get(d.bandId) : "All bands",
    d.packageId
      ? `only “${names.format?.get(d.packageId) ?? "one format"}”`
      : d.releaseId
        ? `release “${names.release.get(d.releaseId)}”`
        : null,
    d.itemCategory ? ITEM_CATEGORIES.find((c) => c.value === d.itemCategory)?.label.toLowerCase() : null,
    d.formatMatch ? `format: ${d.formatMatch}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const window = d.effectiveFrom || d.effectiveTo ? `${d.effectiveFrom ?? "…"} → ${d.effectiveTo ?? "…"}` : null;
  return { amount, destination, scope, window };
}

export function DeductionList({
  items,
  names,
  bands,
  releases,
  people,
  fixedBandId,
}: {
  items: Deduction[];
  names: Names;
  bands: Option[];
  releases: ReleaseOption[];
  people: Option[];
  fixedBandId?: number;
}) {
  if (items.length === 0) return <p className="text-sm text-muted">None.</p>;
  return (
    <ul className="space-y-3">
      {items.map((d) => {
        const desc = describeDeduction(d, names);
        return (
          <li key={d.id} className="rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{d.label}</span>
              <Badge tone="accent">{desc.amount}</Badge>
              <span className="text-xs">{desc.destination}</span>
              <span className="text-xs text-muted">{desc.scope}</span>
              {desc.window && <span className="text-xs text-muted">{desc.window}</span>}
            </div>
            <div className="mt-2 flex flex-wrap items-start gap-2">
              <Disclosure summary="Edit">
                <DeductionForm deduction={d} bands={bands} releases={releases} people={people} fixedBandId={fixedBandId} />
              </Disclosure>
              <form action={deleteDeduction}>
                <input type="hidden" name="id" value={d.id} />
                <SubmitButton variant="danger" size="sm" confirm={`Delete “${d.label}”?`}>
                  Delete
                </SubmitButton>
              </form>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export { DeductionForm };
