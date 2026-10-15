import type { schema } from "@/db";
import { saveBand } from "@/server/actions";
import { SubmitButton } from "./client";
import { Field } from "./ui";

/**
 * A band's details: the same form for the label (on the band's Settings tab) and for the band's own
 * account (its Settings), except the label's notes, which only the label sees.
 */
export function BandFields({ band, labelNotes = true }: { band?: typeof schema.bands.$inferSelect; labelNotes?: boolean }) {
  return (
    <form action={saveBand} className="grid gap-4 sm:grid-cols-2">
      {band && <input type="hidden" name="id" value={band.id} />}
      <Field label="Band name" hint="Exactly as it appears in Bandcamp's “artist” column.">
        <input name="name" required defaultValue={band?.name} />
      </Field>
      <Field label="Other artist spellings" hint="Comma-separated.">
        <input name="aliases" defaultValue={band?.aliases.join(", ")} />
      </Field>
      <Field
        label="Bandcamp URLs"
        hint="Comma-separated. A subdomain (“glassharbor”), a host (“glassharbor.com”) or a URL prefix (“label.bandcamp.com/album/night-swims”)."
        className="sm:col-span-2"
      >
        <input name="urlPatterns" defaultValue={band?.urlPatterns.join(", ")} />
      </Field>
      {labelNotes && (
        <Field label="Notes" className="sm:col-span-2">
          <textarea name="notes" rows={2} defaultValue={band?.notes ?? ""} />
        </Field>
      )}
      <div className="sm:col-span-2">
        <SubmitButton>{band ? "Save band" : "Add band"}</SubmitButton>
      </div>
    </form>
  );
}
