"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { acceptInvite, createAccount, type FormState, resetPassword, saveSetupLinks, saveSetupMe, signIn, signUp } from "@/server/account-actions";
import { connectExistingAccount, joinWithInviteLink } from "@/server/band-invite-actions";
import { buttonClass, Field } from "./ui";

function Result({ state }: { state: FormState }) {
  if (state?.error) return <p className="text-sm text-bad">{state.error}</p>;
  if (state?.ok) return <p className="text-sm text-good">{state.ok}</p>;
  return null;
}

function Submit({ pending, children }: { pending: boolean; children: React.ReactNode }) {
  return (
    <button type="submit" disabled={pending} className={`${buttonClass("primary")} w-full justify-center`}>
      {pending ? "…" : children}
    </button>
  );
}

export function SignInForm({ next, email }: { next: string; email?: string }) {
  const [state, action, pending] = useActionState(signIn, null);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <Field label="Email">
        <input name="email" type="email" autoComplete="email" required defaultValue={email} />
      </Field>
      <Field label="Password">
        <input name="password" type="password" autoComplete="current-password" required />
      </Field>
      <Result state={state} />
      <Submit pending={pending}>Sign in</Submit>
    </form>
  );
}

export function SignUpForm({
  next,
  email,
  name,
  code,
  emailLocked = false,
}: {
  next: string;
  email?: string;
  /** Their name, when whoever invited them already knows it: then it isn't asked for. */
  name?: string;
  code?: string;
  emailLocked?: boolean;
}) {
  const [state, action, pending] = useActionState(signUp, null);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      {code && <input type="hidden" name="code" value={code} />}
      {name ? (
        <input type="hidden" name="name" value={name} />
      ) : (
        <Field label="Your name">
          <input name="name" autoComplete="name" required />
        </Field>
      )}
      <Field label="Email">
        <input name="email" type="email" autoComplete="email" required defaultValue={email} readOnly={emailLocked} />
      </Field>
      <Field label="Password" hint="At least 8 characters.">
        <input name="password" type="password" autoComplete="new-password" minLength={8} required />
      </Field>
      <Result state={state} />
      <Submit pending={pending}>Create account</Submit>
    </form>
  );
}

export function CreateAccountForm() {
  const [state, action, pending] = useActionState(createAccount, null);
  return (
    <form action={action} className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">This group is</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="kind" value="label" defaultChecked className="mt-1" />
          <span>
            <b>A label</b>
            <span className="block text-muted">Several bands, their members, and payouts across all of them.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="kind" value="band" className="mt-1" />
          <span>
            <b>A band</b>
            <span className="block text-muted">One band and its members, splitting what you earn.</span>
          </span>
        </label>
      </fieldset>
      <Field label="Name" hint="Your label or band name.">
        <input name="name" required />
      </Field>
      <Result state={state} />
      <Submit pending={pending}>Create group</Submit>
    </form>
  );
}

/** Accept an invite. `auto`: straight after creating a login for it, accept without another click. */
export function AcceptInviteForm({ id, auto = false }: { id: string; auto?: boolean }) {
  const [state, action, pending] = useActionState(acceptInvite, null);
  const form = useRef<HTMLFormElement>(null);
  const sent = useRef(false);
  useEffect(() => {
    if (auto && !sent.current) {
      sent.current = true;
      form.current?.requestSubmit();
    }
  }, [auto]);
  return (
    <form ref={form} action={action} className="space-y-3">
      <input type="hidden" name="id" value={id} />
      <Result state={state} />
      <Submit pending={pending}>Accept invite</Submit>
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(resetPassword, null);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <Field label="New password" hint="At least 8 characters.">
        <input name="password" type="password" autoComplete="new-password" minLength={8} required />
      </Field>
      <Result state={state} />
      <Submit pending={pending}>Save new password</Submit>
    </form>
  );
}

/**
 * Join a band's account (or a label's) with an invite link. `members`: its people without a login of
 * their own yet, to pick from (or add yourself, or be the band's shared login); null when the link
 * already says who. `details`: what this login already has for itself, to check or change before
 * joining (saved everywhere it's someone). `auto`: straight after signing up or in, when there's
 * nothing to choose.
 */
export function JoinBandForm({
  id,
  bandName,
  members,
  forLabel = false,
  askRole = !forLabel,
  sharedTaken = false,
  auto = false,
  details,
}: {
  id: string;
  bandName: string;
  members: { id: number; name: string }[] | null;
  /** An account's own invite link (a label's, or a band's that runs its own account): no shared login. */
  forLabel?: boolean;
  /** Ask someone new what they do in the band. */
  askRole?: boolean;
  /** The band already has its shared login: no second one. */
  sharedTaken?: boolean;
  auto?: boolean;
  details: { name: string; email: string | null; paypalMe: string | null; venmo: string | null; cashtag: string | null };
}) {
  const [state, action, pending] = useActionState(joinWithInviteLink, null);
  const [as, setAs] = useState(members?.[0] ? String(members[0].id) : "new");
  const form = useRef<HTMLFormElement>(null);
  const sent = useRef(false);
  useEffect(() => {
    if (auto && !members && !sent.current) {
      sent.current = true;
      form.current?.requestSubmit();
    }
  }, [auto, members]);
  return (
    <form ref={form} action={action} className="space-y-4">
      <input type="hidden" name="id" value={id} />
      {members && (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">Who are you?</legend>
          {members.map((m) => (
            <label key={m.id} className="flex items-center gap-2 text-sm">
              <input type="radio" name="as" value={m.id} checked={as === String(m.id)} onChange={() => setAs(String(m.id))} /> {m.name}
            </label>
          ))}
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="as" value="new" checked={as === "new"} onChange={() => setAs("new")} /> I’m not listed
          </label>
          {!forLabel && !sharedTaken && (
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="as" value="band" checked={as === "band"} onChange={() => setAs("band")} /> The whole band (one shared account)
            </label>
          )}
        </fieldset>
      )}
      {/* Their details, to check before joining: saved to every record that's theirs. */}
      {members && as !== "band" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <h2 className="text-sm font-medium sm:col-span-2">Your details</h2>
          <Field label="Your name">
            <input name="name" autoComplete="name" required={as === "new"} defaultValue={details.name === bandName ? "" : details.name} />
          </Field>
          <Field label="PayPal email">
            <input name="email" type="email" defaultValue={details.email ?? ""} />
          </Field>
          <Field label="PayPal.me handle">
            <input name="paypalMe" defaultValue={details.paypalMe ?? ""} />
          </Field>
          <Field label="Venmo username" hint="US only.">
            <input name="venmo" defaultValue={details.venmo ?? ""} placeholder="@yourname" />
          </Field>
          <Field label="Cash App $cashtag">
            <input name="cashtag" defaultValue={details.cashtag ?? ""} placeholder="$yourname" />
          </Field>
          {askRole && as === "new" && (
            <Field label="Role in the band">
              <input name="role" />
            </Field>
          )}
        </div>
      )}
      <Result state={state} />
      <Submit pending={pending}>{`Join ${bandName}`}</Submit>
    </form>
  );
}

/** Setting up a new account, step 1: where it is. */
export function SetupLinksForm({ kind, saved }: { kind: "label" | "band"; saved: { bandcampUrl: string; spotifyUrl: string; appleMusicUrl: string } }) {
  const [state, action, pending] = useActionState(saveSetupLinks, null);
  return (
    <form action={action} className="space-y-4">
      <Field label="Bandcamp address">
        <input name="bandcampUrl" defaultValue={saved.bandcampUrl} placeholder={kind === "band" ? "yourband.bandcamp.com" : "yourlabel.bandcamp.com"} />
      </Field>
      <Field label="Spotify">
        <input name="spotifyUrl" type="url" defaultValue={saved.spotifyUrl} placeholder="https://open.spotify.com/artist/…" />
      </Field>
      <Field label="Apple Music">
        <input name="appleMusicUrl" type="url" defaultValue={saved.appleMusicUrl} placeholder="https://music.apple.com/…" />
      </Field>
      <Result state={state} />
      <Submit pending={pending}>Continue</Submit>
    </form>
  );
}

/**
 * Setting up a new account, step 2: is whoever made it in it (a member of the band, someone the
 * label pays)? If so, their details, starting from what their login already has.
 */
export function SetupMeForm({
  kind,
  name,
  details,
}: {
  kind: "label" | "band";
  name: string;
  details: { name: string; email: string | null; paypalMe: string | null; venmo: string | null; cashtag: string | null };
}) {
  const [state, action, pending] = useActionState(saveSetupMe, null);
  const [inIt, setInIt] = useState(kind === "band" ? "yes" : "no");
  return (
    <form action={action} className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">{kind === "band" ? `Are you in ${name}?` : `Does ${name} pay you?`}</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="inIt" value="yes" checked={inIt === "yes"} onChange={() => setInIt("yes")} />
          {kind === "band" ? "Yes, I’m a member" : "Yes, I get paid from its sales"}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="inIt" value="no" checked={inIt === "no"} onChange={() => setInIt("no")} />
          {kind === "band" ? "No, I just run it" : "No"}
        </label>
      </fieldset>
      {inIt === "yes" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Your name">
            <input name="name" required autoComplete="name" defaultValue={details.name} />
          </Field>
          {kind === "band" && (
            <Field label="Role in the band">
              <input name="role" />
            </Field>
          )}
          <Field label="PayPal email">
            <input name="email" type="email" defaultValue={details.email ?? ""} />
          </Field>
          <Field label="PayPal.me handle">
            <input name="paypalMe" defaultValue={details.paypalMe ?? ""} />
          </Field>
          <Field label="Venmo username" hint="US only.">
            <input name="venmo" defaultValue={details.venmo ?? ""} placeholder="@yourname" />
          </Field>
          <Field label="Cash App $cashtag">
            <input name="cashtag" defaultValue={details.cashtag ?? ""} placeholder="$yourname" />
          </Field>
        </div>
      )}
      <Result state={state} />
      <Submit pending={pending}>Done</Submit>
    </form>
  );
}

/** On a label's invite link for one of its bands: connect the band account you already run instead of joining a new one. */
export function ConnectExistingForm({ id, accounts, labelName }: { id: string; accounts: { id: string; name: string }[]; labelName: string }) {
  const [state, action, pending] = useActionState(connectExistingAccount, null);
  const [orgId, setOrgId] = useState(accounts[0]?.id ?? "");
  const name = accounts.find((a) => a.id === orgId)?.name ?? "";
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(`Connect ${name} to ${labelName}? It keeps its own books, and shows what ${labelName} has for it.`)) e.preventDefault();
      }}
      className="space-y-3"
    >
      <input type="hidden" name="id" value={id} />
      {accounts.length > 1 ? (
        <Field label="Your band">
          <select name="orgId" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <input type="hidden" name="orgId" value={orgId} />
      )}
      <Result state={state} />
      <button type="submit" disabled={pending} className={`${buttonClass("secondary")} w-full justify-center`}>
        {pending ? "…" : `Connect ${name}`}
      </button>
    </form>
  );
}
