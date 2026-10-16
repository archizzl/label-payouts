import { SubmitButton } from "@/components/client";
import type { ViewingAs } from "@/server/context";
import { startViewAs, stopViewAs } from "@/server/view-as-actions";

/** Across the top while a label admin is viewing as one of its bands or people. */
export function ViewingAsBar({ viewing }: { viewing: ViewingAs }) {
  return (
    <div className="no-print border-b border-warn/30 bg-warn-bg text-sm text-warn">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 md:px-8">
        <span>
          Viewing as <b>{viewing.name}</b>
          {viewing.kind === "band" ? ", in their band’s group" : ` in ${viewing.label.name}`}. This is what they see. Nothing can be changed
          while you’re viewing.
        </span>
        <form action={stopViewAs} className="ml-auto">
          <input type="hidden" name="back" value={viewing.back} />
          <SubmitButton variant="secondary" size="sm">
            Stop viewing
          </SubmitButton>
        </form>
      </div>
    </div>
  );
}

/** "View as" for a band (its sub-account) or a person, for a label's admins. A name keeps its own capitals. */
export function ViewAsButton({ kind, id, name, prefix = "View as" }: { kind: "band" | "person"; id: number; name?: string; prefix?: string }) {
  return (
    <form action={startViewAs} className="inline">
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="id" value={id} />
      <SubmitButton variant="secondary" size="sm">
        {prefix}
        {name && <span className="normal-case">{name}</span>}
      </SubmitButton>
    </form>
  );
}
