"use client";

import { useActionState, useEffect, useRef } from "react";
import { buttonClass } from "@/components/ui";

type State = { ok?: string; error?: string } | null;

/**
 * Choose or replace a photo, and remove it: picking a file uploads it straight away. The action
 * gets the file as "photo", or "remove" = "1" to take it off, plus any `fields`.
 */
export function PhotoButtons({
  action,
  fields = {},
  hasPhoto,
}: {
  action: (state: State, fd: FormData) => Promise<State>;
  fields?: Record<string, string | number>;
  hasPhoto: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const form = useRef<HTMLFormElement>(null);
  const file = useRef<HTMLInputElement>(null);
  // Picking the same file again (after an error, say) still counts as a change.
  useEffect(() => {
    if (file.current) file.current.value = "";
  }, [state]);
  return (
    <form ref={form} action={formAction} className="flex flex-wrap items-center gap-2">
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <input
        ref={file}
        type="file"
        name="photo"
        accept="image/jpeg,image/png,image/gif,image/webp"
        hidden
        onChange={() => file.current?.files?.length && form.current?.requestSubmit()}
      />
      <button type="button" disabled={pending} onClick={() => file.current?.click()} className={buttonClass("secondary", "sm")}>
        {pending ? "Saving…" : hasPhoto ? "Replace photo" : "Choose photo"}
      </button>
      {hasPhoto && (
        <button
          type="submit"
          name="remove"
          value="1"
          disabled={pending}
          onClick={(e) => {
            if (!confirm("Remove this photo?")) e.preventDefault();
          }}
          className={buttonClass("ghost", "sm")}
        >
          Remove photo
        </button>
      )}
      {state?.error && <p className="w-full text-sm text-bad">{state.error}</p>}
    </form>
  );
}
