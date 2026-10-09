"use client";

import { useEffect, useRef, useState } from "react";
import { Field } from "./ui";

/**
 * The invite form's email and "They are": choosing someone already in the account fills in the
 * email on file for them (unless you've typed a different one yourself).
 */
export function InviteWhoFields({ people }: { people: { id: number; name: string; email: string | null }[] }) {
  const [email, setEmail] = useState("");
  // The email we last filled in, so choosing someone else replaces it but never what you typed.
  const [filled, setFilled] = useState("");
  // Start fresh when the form is cleared after sending an invite.
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const form = input.current?.form;
    const clear = () => {
      setEmail("");
      setFilled("");
    };
    form?.addEventListener("reset", clear);
    return () => form?.removeEventListener("reset", clear);
  }, []);
  return (
    <>
      <Field label="Their email">
        <input ref={input} name="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="They are" hint="Links their login to their earnings.">
        <select
          name="personId"
          defaultValue=""
          onChange={(e) => {
            const next = people.find((p) => String(p.id) === e.target.value)?.email ?? "";
            if (email === "" || email === filled) {
              setEmail(next);
              setFilled(next);
            }
          }}
        >
          <option value="">Someone new</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.email ? ` (${p.email})` : ""}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}
