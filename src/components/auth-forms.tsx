"use client";

import { useActionState } from "react";
import { acceptInvite, createAccount, type FormState, signIn, signUp } from "@/server/account-actions";
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

export function SignUpForm({ next, email }: { next: string; email?: string }) {
  const [state, action, pending] = useActionState(signUp, null);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <Field label="Your name">
        <input name="name" autoComplete="name" required />
      </Field>
      <Field label="Email">
        <input name="email" type="email" autoComplete="email" required defaultValue={email} />
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
      <Field label="Name" hint="Your label or band name, as on Bandcamp.">
        <input name="name" required />
      </Field>
      <Result state={state} />
      <Submit pending={pending}>Create account</Submit>
    </form>
  );
}

export function AcceptInviteForm({ id }: { id: string }) {
  const [state, action, pending] = useActionState(acceptInvite, null);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="id" value={id} />
      <Result state={state} />
      <Submit pending={pending}>Accept invite</Submit>
    </form>
  );
}
