import { ActionForm, SubmitButton } from "@/components/client";
import { Card, Field } from "@/components/ui";
import { deleteMyLogin } from "@/server/account-actions";

/** At the bottom of Settings: delete your login everywhere (the books stay). Type your email to confirm. */
export function DeleteLogin({ email }: { email: string }) {
  return (
    <Card title="Delete my login">
      <ActionForm action={deleteMyLogin} className="flex flex-wrap items-end gap-3">
        <Field label={`Type ${email} to confirm`} className="min-w-64">
          <input name="email" type="email" required autoComplete="off" />
        </Field>
        <SubmitButton variant="danger" size="sm" confirm="Delete your login? You won’t be able to sign in with it again, to any account.">
          Delete my login
        </SubmitButton>
      </ActionForm>
    </Card>
  );
}
