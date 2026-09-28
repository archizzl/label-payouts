"use client";

import { type ReactNode, useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import type { ActionState } from "@/server/actions";
import { buttonClass } from "./ui";

/** Close the add/edit panel (a <details>) that an element sits in. */
export function closeEnclosingPanel(el: Element | null | undefined) {
  el?.closest("details")?.removeAttribute("open");
}

/**
 * A form bound to an action that returns { ok } / { error }, with inline feedback. On success the
 * panel it's in closes; on an error it stays open so you can see what went wrong.
 */
export function ActionForm({
  action,
  children,
  className = "",
}: {
  action: (state: ActionState, fd: FormData) => Promise<ActionState>;
  children: ReactNode;
  className?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) closeEnclosingPanel(ref.current);
  }, [state]);
  return (
    // data-action-form: this form decides for itself when to close (only on success).
    <form ref={ref} action={formAction} className={className} data-action-form="">
      {children}
      {state?.error && <p className="mt-2 text-sm text-bad">{state.error}</p>}
      {state?.ok && <p className="mt-2 text-sm text-good">{state.ok}</p>}
    </form>
  );
}

export function SubmitButton({
  children,
  variant = "primary",
  size = "md",
  confirm,
  name,
  value,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
  confirm?: string;
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();
  const ref = useRef<HTMLButtonElement>(null);
  const wasPending = useRef(false);
  // When the action finishes, close the add/edit panel this form sits in: the job's done.
  // (Forms that report errors inline handle closing themselves; see ActionForm.)
  useEffect(() => {
    if (wasPending.current && !pending && !ref.current?.form?.hasAttribute("data-action-form")) {
      closeEnclosingPanel(ref.current);
    }
    wasPending.current = pending;
  }, [pending]);
  return (
    <button
      ref={ref}
      type="submit"
      name={name}
      value={value}
      disabled={pending}
      className={buttonClass(variant, size)}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending ? "Working…" : children}
    </button>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={buttonClass("secondary", "sm")}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

export function PrintButton() {
  return (
    <button type="button" className={buttonClass("primary")} onClick={() => window.print()}>
      Print / save as PDF
    </button>
  );
}
