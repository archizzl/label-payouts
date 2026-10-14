import { ActionForm, SaveWhenChanged, SubmitButton } from "@/components/client";
import { Card, Field } from "@/components/ui";
import { saveMyDetails } from "@/server/band-member-actions";

type Person = { name: string; email: string | null; paypalMe: string | null; venmo: string | null; cashtag: string | null };

/** A band member's own details in the label's books, from their own login's Settings. */
export function MyDetails({ person, roles }: { person: Person; roles: string[] }) {
  return (
    <Card title="Your details">
      <ActionForm action={saveMyDetails} keepOpen className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <input name="name" required defaultValue={person.name} />
        </Field>
        <Field label="Roles in the band" hint="Comma-separated.">
          <input name="roles" defaultValue={Array.isArray(roles) ? roles.join(", ") : ""} placeholder="vocals, guitar" />
        </Field>
        <Field label="PayPal email">
          <input name="email" type="email" defaultValue={person.email ?? ""} />
        </Field>
        <Field label="PayPal.me handle">
          <input name="paypalMe" defaultValue={person.paypalMe ?? ""} />
        </Field>
        <Field label="Venmo username" hint="US only.">
          <input name="venmo" defaultValue={person.venmo ?? ""} placeholder="@yourname" />
        </Field>
        <Field label="Cash App $cashtag">
          <input name="cashtag" defaultValue={person.cashtag ?? ""} placeholder="$yourname" />
        </Field>
        <div className="sm:col-span-2">
          <SaveWhenChanged>
            <SubmitButton>Save</SubmitButton>
          </SaveWhenChanged>
        </div>
      </ActionForm>
    </Card>
  );
}
