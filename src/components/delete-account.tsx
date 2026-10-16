import { ActionForm, SubmitButton } from "@/components/client";
import { Card, Field } from "@/components/ui";
import { deleteAccount } from "@/server/account-actions";

/** At the bottom of Settings (admins): delete the whole account and its books. Type its name to confirm. */
export function DeleteAccount({ name, orgId, label }: { name: string; orgId: string; label: boolean }) {
  return (
    <Card title={`Delete ${name}`}>
      <ActionForm action={deleteAccount} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="orgId" value={orgId} />
        <Field label={`Type ${name} to confirm`} className="min-w-64">
          <input name="name" required autoComplete="off" />
        </Field>
        <SubmitButton
          variant="danger"
          size="sm"
          confirm={`Delete ${name}? Its books, people, payouts and receipts${label ? ", and its bands’ groups," : ""} are deleted for good. This can’t be undone.`}
        >
          Delete {name}
        </SubmitButton>
      </ActionForm>
    </Card>
  );
}
