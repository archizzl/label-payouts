import type { schema } from "@/db";
import { saveBand } from "@/server/actions";
import { SubmitButton } from "./client";
import { Field } from "./ui";

export function BandFields({ band }: { band?: typeof schema.bands.$inferSelect }) {
  return (
    <form action={saveBand} className="grid gap-4 sm:grid-cols-2">
      {band && <input type="hidden" name="id" value={band.id} />}
      <Field label="Band name" hint="Exactly as it appears in Bandcamp's “artist” column.">
        <input name="name" required defaultValue={band?.name} />
      </Field>
      <Field label="Other artist spellings" hint="Comma-separated, e.g. “GH, Glass Harbour”.">
        <input name="aliases" defaultValue={band?.aliases.join(", ")} />
      </Field>
      <Field
        label="Bandcamp URLs"
        hint="Comma-separated. A subdomain (“glassharbor”), a host (“glassharbor.com”) or a URL prefix (“label.bandcamp.com/album/night-swims”)."
        className="sm:col-span-2"
      >
        <input name="urlPatterns" defaultValue={band?.urlPatterns.join(", ")} />
      </Field>
      <Field label="Notes" className="sm:col-span-2">
        <textarea name="notes" rows={2} defaultValue={band?.notes ?? ""} />
      </Field>
      <div className="sm:col-span-2">
        <SubmitButton>{band ? "Save band" : "Add band"}</SubmitButton>
      </div>
    </form>
  );
}
