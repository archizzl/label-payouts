import { switchBooks } from "@/server/account-actions";
import type { Context } from "@/server/context";

/**
 * A band account the label made that keeps its own books too: which books the page shows, the
 * label's for the band or its own. Nothing for any other account. `back` is where each one goes
 * (the same page, unless it's somewhere else in the other books).
 */
export function BooksSwitch({ ctx, back }: { ctx: Context; back: string | { label: string; own: string } }) {
  const m = ctx.managedBy;
  if (!m?.ownBooks) return null;
  const to = typeof back === "string" ? { label: back, own: back } : back;
  const option = (books: "label" | "own", text: string) => {
    const on = (ctx.books ?? "label") === books;
    return (
      <button
        type="submit"
        name="books"
        value={books}
        aria-pressed={on}
        className={`rounded-full px-3 py-1 ${on ? "bg-text text-bg" : "bg-surface-2 text-muted hover:text-text"}`}
      >
        {text}
      </button>
    );
  };
  return (
    <form action={switchBooks} className="no-print mb-4 flex flex-wrap gap-2 text-sm" aria-label="Books">
      <input type="hidden" name="orgId" value={ctx.org.id} />
      <input type="hidden" name="back_label" value={to.label} />
      <input type="hidden" name="back_own" value={to.own} />
      {option("label", `through ${m.labelName}`)}
      {option("own", "own")}
    </form>
  );
}
