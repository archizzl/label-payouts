import { ActionForm, SubmitButton } from "@/components/client";
import { Card, Field } from "@/components/ui";
import { deleteMyLogin } from "@/server/account-actions";

/**
 * At the bottom of Account: leave every account you're in and delete your login (the books stay).
 * Type your email to confirm.
 */
export function DeleteLogin({ email, accounts }: { email: string; accounts: number }) {
  const title = accounts > 1 ? "Delete all of your accounts" : "Delete your account";
  return (
    <Card title={title}>
      <ActionForm action={deleteMyLogin} className="flex flex-wrap items-end gap-3">
        <Field label={`Type ${email} to confirm`} className="min-w-64">
          <input name="email" type="email" required autoComplete="off" />
        </Field>
        <SubmitButton
          variant="danger"
          size="sm"
          confirm={`${accounts > 1 ? `Leave all ${accounts} accounts and delete` : "Delete"} your login? You won’t be able to sign in with it again. Their books stay as they are.`}
        >
          {accounts > 1 ? "Leave all and delete login" : "Delete login"}
        </SubmitButton>
      </ActionForm>
    </Card>
  );
}
