"use client";

import { useActionState, useState } from "react";
import { applyForAccount } from "@/server/application-actions";
import { buttonClass, Field } from "./ui";

type Row = { key: number };
let nextKey = 1;
const rows = (n: number): Row[] => Array.from({ length: n }, () => ({ key: nextKey++ }));

/** A list of rows that grows: "+ Add another", and × on each row. */
function Rows({ label, items, setItems, render, addLabel }: { label: string; items: Row[]; setItems: (r: Row[]) => void; render: (i: number) => React.ReactNode; addLabel: string }) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      {items.map((r, i) => (
        <div key={r.key} className="flex items-start gap-2">
          <div className="grid flex-1 gap-2 sm:grid-cols-3">{render(i)}</div>
          <button
            type="button"
            className="mt-1 px-1 text-muted hover:text-bad"
            aria-label="Remove this row"
            onClick={() => setItems(items.filter((x) => x.key !== r.key))}
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setItems([...items, ...rows(1)])}>
        + {addLabel}
      </button>
    </fieldset>
  );
}

/**
 * Applying for a label or band account. Asks what's useful for setting it up: a band's members, or
 * a label's artists and team. A site admin reviews it.
 */
export function ApplicationForm({ yourName }: { yourName: string }) {
  const [state, action, pending] = useActionState(applyForAccount, null);
  const [kind, setKind] = useState<"label" | "band">("band");
  const [members, setMembers] = useState(() => rows(3));
  const [artists, setArtists] = useState(() => rows(3));
  const [team, setTeam] = useState(() => rows(1));

  return (
    <form action={action} className="space-y-5">
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">This account is for</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="kind" value="band" checked={kind === "band"} onChange={() => setKind("band")} className="mt-1" />
          <span>
            <b>A band</b>
            <span className="block text-muted">One band and its members, splitting what you earn.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="kind" value="label" checked={kind === "label"} onChange={() => setKind("label")} className="mt-1" />
          <span>
            <b>A label</b>
            <span className="block text-muted">Several artists, their members, and payouts across all of them.</span>
          </span>
        </label>
      </fieldset>

      <Field label={kind === "band" ? "Band name" : "Label name"}>
        <input name="name" required maxLength={120} />
      </Field>
      <Field label="Bandcamp address">
        <input name="bandcampUrl" placeholder={kind === "band" ? "yourband.bandcamp.com" : "yourlabel.bandcamp.com"} />
      </Field>
      <Field label="Website (optional)">
        <input name="website" placeholder="example.com" />
      </Field>

      {kind === "band" ? (
        <Rows
          label="Who’s in the band"
          addLabel="Add a member"
          items={members}
          setItems={setMembers}
          render={(i) => (
            <>
              <input name="memberName" placeholder={i === 0 ? `Name (e.g. ${yourName})` : "Name"} aria-label="Member's name" />
              <input name="memberRole" placeholder="Role (e.g. drums)" aria-label="Member's role" />
              <input name="memberEmail" type="email" placeholder="Email, to invite them (optional)" aria-label="Member's email" />
            </>
          )}
        />
      ) : (
        <>
          <Rows
            label="Artists on the label"
            addLabel="Add an artist"
            items={artists}
            setItems={setArtists}
            render={() => (
              <>
                <input name="artistName" placeholder="Artist name" aria-label="Artist name" className="sm:col-span-1" />
                <input name="artistUrl" placeholder="Their Bandcamp address (optional)" aria-label="Artist's Bandcamp address" className="sm:col-span-2" />
              </>
            )}
          />
          <Rows
            label="Who else runs the label (optional)"
            addLabel="Add someone"
            items={team}
            setItems={setTeam}
            render={() => (
              <>
                <input name="teamName" placeholder="Name" aria-label="Team member's name" />
                <input name="teamEmail" type="email" placeholder="Email, to invite them" aria-label="Team member's email" className="sm:col-span-2" />
              </>
            )}
          />
        </>
      )}
      <p className="-mt-2 text-xs text-muted">
        {kind === "band"
          ? "Everyone listed gets set up to be paid. Those with an email get an invite link to sign in once you’re approved."
          : "Your label’s Bandcamp artists page fills in any you leave out. People with an email get an invite link once you’re approved."}
      </p>

      <Field label="Anything else we should know? (optional)">
        <textarea name="about" rows={3} maxLength={2000} placeholder="How you sell, how many releases, how you split money today…" />
      </Field>

      {state?.error && <p className="text-sm text-bad">{state.error}</p>}
      <button type="submit" disabled={pending} className={`${buttonClass("primary")} w-full justify-center`}>
        {pending ? "…" : "Send for review"}
      </button>
    </form>
  );
}
