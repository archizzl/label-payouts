"use client";

import { createContext, type ReactNode, useActionState, useContext, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import type { ActionState } from "@/server/actions";
import { buttonClass } from "./ui";

/** Why nothing on the page can be changed (a label admin viewing as someone), or null. */
const ReadOnlyReason = createContext<string | null>(null);

/** Turns off every SubmitButton inside, with the reason as its tooltip. The server refuses changes too. */
export function ReadOnly({ reason, children }: { reason: string; children: ReactNode }) {
  return <ReadOnlyReason value={reason}>{children}</ReadOnlyReason>;
}

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
  keepOpen = false,
}: {
  action: (state: ActionState, fd: FormData) => Promise<ActionState>;
  children: ReactNode;
  className?: string;
  /** Stay open after it works, so its confirmation stays in view (e.g. a form for adding one more). */
  keepOpen?: boolean;
}) {
  const [state, formAction] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok && !keepOpen) closeEnclosingPanel(ref.current);
  }, [state, keepOpen]);
  return (
    // data-action-form: this form decides for itself when to close (only on success).
    <form ref={ref} action={formAction} className={className} data-action-form="">
      {children}
      {/* Errors stay until the next try; "done" messages fade after a few seconds. Keyed by the
          result, so each new one shows afresh. */}
      {state?.error && <p className="mt-2 text-sm text-bad">{state.error}</p>}
      {state?.ok && (
        <Fading key={stateKey(state)} className="mt-2 text-sm text-good">
          {state.ok}
        </Fading>
      )}
    </form>
  );
}

/** Each action result is a new object: key on it so a repeated message still fades in again. */
const resultKeys = new WeakMap<object, number>();
let nextResultKey = 0;
function stateKey(state: object) {
  if (!resultKeys.has(state)) resultKeys.set(state, nextResultKey++);
  return resultKeys.get(state)!;
}

/**
 * Shows its content, then fades it out after `seconds` (waiting while the mouse is over it, so
 * there's time to read). With `clearParams`, also takes those values out of the address, so a
 * refresh doesn't bring the message back.
 */
export function Fading({ children, seconds = 5, className = "", clearParams }: { children: ReactNode; seconds?: number; className?: string; clearParams?: string[] }) {
  const [phase, setPhase] = useState<"shown" | "fading" | "gone">("shown");
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (!clearParams?.length) return;
    const url = new URL(window.location.href);
    let changed = false;
    for (const p of clearParams) {
      if (!url.searchParams.has(p)) continue;
      url.searchParams.delete(p);
      changed = true;
    }
    if (changed) window.history.replaceState(window.history.state, "", url);
    // Only on first show.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (hovered || phase === "gone") return;
    const t = setTimeout(() => setPhase((p) => (p === "shown" ? "fading" : "gone")), phase === "shown" ? seconds * 1000 : 400);
    return () => clearTimeout(t);
  }, [hovered, phase, seconds]);
  if (phase === "gone") return null;
  return (
    <div
      role="status"
      onMouseEnter={() => {
        setHovered(true);
        setPhase("shown");
      }}
      onMouseLeave={() => setHovered(false)}
      className={`transition-opacity duration-300 ${phase === "fading" ? "opacity-0" : "opacity-100"} ${className}`}
    >
      {children}
    </div>
  );
}

export function SubmitButton({
  children,
  variant = "primary",
  size = "md",
  confirm,
  name,
  value,
  disabled = false,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
  confirm?: string;
  name?: string;
  value?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  const readOnly = useContext(ReadOnlyReason);
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
      disabled={pending || disabled || !!readOnly}
      title={readOnly ?? undefined}
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
