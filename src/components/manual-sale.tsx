import { ActionForm, SubmitButton } from "@/components/client";
import { Field } from "@/components/ui";
import { MANUAL_KINDS } from "@/lib/manual-sales";
import { addManualSale, deleteManualSale } from "@/server/manual-sale-actions";

/** Sales → Import: add a sale that didn't go through Bandcamp (a show, merch sold in person). */
export function ManualSaleForm({ bands, currency }: { bands: { id: number; name: string }[]; currency: string }) {
  const today = new Date().toLocaleDateString("en-CA");
  return (
    <ActionForm action={addManualSale} keepOpen className="grid gap-4 sm:grid-cols-3">
      <Field label="Date">
        <input name="date" type="date" required defaultValue={today} />
      </Field>
      <Field label="Band">
        <select name="bandId" required defaultValue={bands.length === 1 ? bands[0].id : ""}>
          {bands.length !== 1 && (
            <option value="" disabled>
              Choose a band
            </option>
          )}
          {bands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="What it was">
        <select name="kind" defaultValue="show">
          {MANUAL_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Description" className="sm:col-span-3">
        <input name="itemName" required maxLength={200} />
      </Field>
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
