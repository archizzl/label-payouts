"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { acceptInvite, createAccount, type FormState, resetPassword, signIn, signUp } from "@/server/account-actions";
import { joinWithInviteLink } from "@/server/band-invite-actions";
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
      <Submit pending={pending}>Create login</Submit>
    </form>
  );
}

export function CreateAccountForm() {
  const [state, action, pending] = useActionState(createAccount, null);
  return (
    <form action={action} className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">This account is for</legend>
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
      <Submit pending={pending}>Create account</Submit>
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
 * Join a band's account with an invite link. `members`: the band's members without a login of their
 * own yet, to pick from (or add yourself, or be the band's shared login); null when the link already
 * says who. `auto`: straight after signing up or in, when there's nothing to choose.
 */
export function JoinBandForm({
  id,
  bandName,
  members,
  sharedTaken = false,
  auto = false,
  email = "",
}: {
  id: string;
  bandName: string;
  /** Their login's email: the PayPal email to start from, if they're new to the band. */
  email?: string;
  members: { id: number; name: string }[] | null;
  /** The band already has its shared login: no second one. */
  sharedTaken?: boolean;
  auto?: boolean;
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
          {!sharedTaken && (
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="as" value="band" checked={as === "band"} onChange={() => setAs("band")} /> The whole band (one shared login)
            </label>
          )}
        </fieldset>
      )}
      {/* Someone the label doesn't have yet: their details, as in the Directory. */}
      {members && as === "new" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Your name">
            <input name="name" autoComplete="name" required />
          </Field>
          <Field label="Role in the band">
            <input name="role" />
          </Field>
          <Field label="PayPal email">
            <input name="email" type="email" defaultValue={email} />
          </Field>
          <Field label="PayPal.me handle">
            <input name="paypalMe" />
          </Field>
          <Field label="Venmo username" hint="US only.">
            <input name="venmo" placeholder="@yourname" />
          </Field>
          <Field label="Cash App $cashtag">
            <input name="cashtag" placeholder="$yourname" />
          </Field>
        </div>
      )}
      <Result state={state} />
      <Submit pending={pending}>{`Join ${bandName}`}</Submit>
    </form>
  );
}
