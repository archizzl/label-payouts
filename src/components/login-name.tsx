import { ActionForm, SaveWhenChanged, SubmitButton } from "@/components/client";
import { Card, Field } from "@/components/ui";
import { saveLoginName } from "@/server/account-actions";

/** In Settings, in every account: the name your login goes by. */
export function LoginName({ name, email }: { name: string; email: string }) {
  return (
    <Card title="Your login">
      <ActionForm action={saveLoginName} className="flex flex-wrap items-end gap-3">
        <Field label={`Name for ${email}`} className="min-w-64">
          <input name="name" required defaultValue={name} autoComplete="name" />
        </Field>
        <SaveWhenChanged>
          <SubmitButton size="sm">Save</SubmitButton>
        </SaveWhenChanged>
      </ActionForm>
    </Card>
  );
}
