import Link from "next/link";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "money", label: "Money" },
  { key: "people", label: "People" },
  { key: "catalog", label: "Catalog" },
  { key: "settings", label: "Settings" },
] as const;

export type BandTab = (typeof TABS)[number]["key"];

/** The parts of a band's page: how it's doing, its money rules, its people, its releases, its settings. */
export function BandTabs({ bandId, active, needsSplit, members }: { bandId: number; active: BandTab; needsSplit: boolean; members: number }) {
  return (
    <nav className="mb-8 flex gap-6 overflow-x-auto border-b border-border text-sm" aria-label="Band">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={t.key === "overview" ? `/bands/${bandId}` : `/bands/${bandId}?tab=${t.key}`}
          className={`border-b-2 pb-1 whitespace-nowrap hover:no-underline ${active === t.key ? "border-accent font-bold text-text" : "border-transparent text-muted hover:text-text"}`}
        >
          {t.label}
          {t.key === "money" && needsSplit && (
            <span className="ml-1.5 rounded-full bg-bad-bg px-1.5 text-xs text-bad" title="No split yet: its sales can't be paid">
              !
            </span>
          )}
          {t.key === "people" && <span className="ml-1.5 text-xs text-muted">{members}</span>}
        </Link>
      ))}
    </nav>
  );
}
