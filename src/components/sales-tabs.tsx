import Link from "next/link";

/** Browse / Import, at the top of the Sales tab. */
export function SalesTabs({ active, unrouted = 0, canImport = true }: { active: "browse" | "import"; unrouted?: number; canImport?: boolean }) {
  const tab = (key: "browse" | "import", href: string, label: React.ReactNode) => (
    <Link
      href={href}
      className={`rounded-lg px-3 py-1.5 hover:no-underline ${active === key ? "bg-surface font-semibold text-text shadow-sm" : "text-muted hover:text-text"}`}
    >
      {label}
    </Link>
  );
  return (
    <nav className="mb-6 inline-flex gap-1 rounded-xl bg-surface-2 p-1 text-sm" aria-label="Sales">
      {tab("browse", "/sales", "All sales")}
      {canImport &&
        tab(
          "import",
          "/sales/import",
          <>
            Import{unrouted > 0 && <span className="ml-1.5 rounded-full bg-bad-bg px-1.5 text-xs text-bad">{unrouted}</span>}
          </>,
        )}
    </nav>
  );
}
