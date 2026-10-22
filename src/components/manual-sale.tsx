import { ActionForm, SubmitButton } from "@/components/client";
import { Field } from "@/components/ui";
import { ManualSaleFields, type MerchChoice } from "@/components/manual-sale-fields";
import { addManualSale, deleteManualSale } from "@/server/manual-sale-actions";

/** Sales → Import: add a sale that didn't go through Bandcamp (a show, merch sold in person). */
export function ManualSaleForm({ bands, merch, currency }: { bands: { id: number; name: string }[]; merch: MerchChoice[]; currency: string }) {
  const today = new Date().toLocaleDateString("en-CA");
  return (
    <ActionForm action={addManualSale} keepOpen className="grid gap-4 sm:grid-cols-3">
      <Field label="Date">
        <input name="date" type="date" required defaultValue={today} />
      </Field>
      <ManualSaleFields bands={bands} merch={merch} currency={currency} />
      <div className="sm:col-span-3">
        <SubmitButton>Add</SubmitButton>
      </div>
    </ActionForm>
  );
}

/** On a hand-added sale in the list: take it back out (until it's paid out), or the whole order it was part of. */
export function DeleteManualSale({ id, orderItems = 1 }: { id: number; orderItems?: number }) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      <ActionForm action={deleteManualSale}>
        <input type="hidden" name="id" value={id} />
        <SubmitButton variant="ghost" size="sm" confirm={orderItems > 1 ? "Delete this item from the order?" : "Delete this sale?"}>
          {orderItems > 1 ? "Delete this item" : "Delete sale"}
        </SubmitButton>
      </ActionForm>
      {orderItems > 1 && (
        <ActionForm action={deleteManualSale}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="whole" value="1" />
          <SubmitButton variant="ghost" size="sm" confirm={`Delete the whole order (${orderItems} items)?`}>
            Delete the whole order
          </SubmitButton>
        </ActionForm>
      )}
    </div>
  );
}
