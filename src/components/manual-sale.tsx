import { ActionForm, SubmitButton } from "@/components/client";
import { Field } from "@/components/ui";
import { ManualSaleFields, type MerchChoice } from "@/components/manual-sale-fields";
import type { ReleasePackage } from "@/db/schema";
import { addManualSale, deleteManualSale } from "@/server/manual-sale-actions";

/** Sales → Import: add a sale that didn't go through Bandcamp (a show, merch sold in person). */
export function ManualSaleForm({ bands, merch, currency }: { bands: { id: number; name: string }[]; merch: MerchChoice[]; currency: string }) {
  const today = new Date().toLocaleDateString("en-CA");
  return (
    <ActionForm action={addManualSale} keepOpen className="grid gap-4 sm:grid-cols-3">
      <Field label="Date">
        <input name="date" type="date" required defaultValue={today} />
      </Field>
      <ManualSaleFields bands={bands} merch={merch} />
      <Field label="Amount received">
        <input name="amount" required inputMode="decimal" />
      </Field>
      <Field label="Currency">
        <input name="currency" required defaultValue={currency} maxLength={3} className="uppercase" />
      </Field>
      <Field label="Quantity">
        <input name="quantity" type="number" min={1} defaultValue={1} />
      </Field>
      <div className="sm:col-span-3">
        <SubmitButton>Add sale</SubmitButton>
      </div>
    </ActionForm>
  );
}

/** On a hand-added sale in the list: take it back out (until it's paid out). */
export function DeleteManualSale({ id }: { id: number }) {
  return (
    <ActionForm action={deleteManualSale} className="mt-2">
      <input type="hidden" name="id" value={id} />
      <SubmitButton variant="ghost" size="sm" confirm="Delete this sale?">
        Delete sale
      </SubmitButton>
    </ActionForm>
  );
}

/**
 * The merch a hand-added sale can be for: merch items (each of their kinds, if they have several)
 * and releases' physical formats, as "<release id>:<package id>".
 */
export function merchChoices(releases: { id: number; title: string; kind: string; bandId: number | null; packages: ReleasePackage[] }[]): MerchChoice[] {
  return releases.flatMap((r) => {
    if (r.kind === "merch" && !r.packages.length) return [{ value: `${r.id}:`, label: r.title, bandId: r.bandId }];
    return r.packages.map((p) => ({
      value: `${r.id}:${p.bandcampId}`,
      label: r.kind === "merch" && p.title === r.title ? r.title : `${r.title} — ${p.title}`,
      bandId: r.bandId,
    }));
  });
}
