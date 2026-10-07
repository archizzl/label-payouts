"use client";

import { useActionState } from "react";
import { type AdminState, passwordResetLink } from "@/server/admin-actions";
import { CopyButton } from "./client";
import { buttonClass } from "./ui";

/** "Reset link": makes a one-time password reset link for a login and shows it, ready to copy. */
export function ResetLinkButton({ userId }: { userId: string }) {
  const [state, action, pending] = useActionState<AdminState, FormData>(passwordResetLink, null);
  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="userId" value={userId} />
      {!state?.link && (
        <button type="submit" disabled={pending} className={buttonClass("ghost", "sm")}>
          {pending ? "…" : "Reset link"}
        </button>
      )}
      {state?.error && <p className="text-xs text-bad">{state.error}</p>}
      {state?.link && (
        <div className="text-xs">
          <p className="text-muted">{state.ok}</p>
          <div className="mt-1 flex items-center gap-2">
            <code className="max-w-56 truncate">{state.link}</code>
            <CopyButton text={state.link} />
          </div>
        </div>
      )}
    </form>
  );
}
