import type { deductions as deductionsTable } from "@/db/schema";
import { formatCents } from "@/lib/money";
import { deleteDeduction, saveItemCost } from "@/server/actions";
import { SubmitButton } from "./client";
import { Disclosure } from "./ui";

type Deduction = typeof deductionsTable.$inferSelect;

/**
 * Per-item costs on one physical format or merch item, with a remove link each and a tiny
 * "+ cost" form: amount, and whether it's withheld or paid to someone. Nothing else to choose.
 */
export function ItemCosts({
  costs,
  releaseId,
  packageId,
  currency,
  people,
  personName,
}: {
  costs: Deduction[];
  releaseId: number;
  packageId?: number | null;
  currency: string;
  people: { id: number; name: string }[];
  personName: Map<number, string>;
}) {
  return (
    <div className="space-y-1">
      {costs.map((d) => (
        <div key={d.id} className="flex items-baseline gap-2 text-sm whitespace-nowrap">
          <span>{formatCents(d.amountCents ?? 0, d.currency ?? "USD")}</span>
          <span className="text-xs text-muted">
            {d.destination === "person" && d.personId ? `to ${personName.get(d.personId)}` : "withheld"}
            {d.bandId == null && " · label-wide"}
            {d.packageId == null && d.releaseId == null && d.bandId != null && " · band-wide"}
          </span>
          {/* Only costs made for exactly this item can be removed here; broader ones live on the band / label rules pages. */}
          {d.releaseId === releaseId && (d.packageId ?? null) === (packageId ?? null) && (
            <form action={deleteDeduction}>
              <input type="hidden" name="id" value={d.id} />
              <SubmitButton variant="ghost" size="sm" confirm="Remove this cost?">
                Remove
              </SubmitButton>
            </form>
          )}
        </div>
      ))}
      <Disclosure summary="+ cost">
        <form action={saveItemCost} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="releaseId" value={releaseId} />
          {packageId != null && <input type="hidden" name="packageId" value={packageId} />}
          <input type="hidden" name="currency" value={currency} />
          <label className="block">
            <span className="mb-1 block text-xs text-muted">cost per item ({currency})</span>
            <input name="amount" inputMode="decimal" required placeholder="3.42" className="!w-24" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted">where it goes</span>
            <select name="payTo" defaultValue="withheld" className="!w-auto">
              <option value="withheld">withheld to pay the cost</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  paid to {p.name}
                </option>
              ))}
            </select>
          </label>
          <SubmitButton size="sm">add cost</SubmitButton>
        </form>
      </Disclosure>
    </div>
  );
}
