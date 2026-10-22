import Link from "next/link";

type Tab = "funds" | "rules";

/** Label funds / Rules, at the top of the Funds tab (only the ones they can see; no bar for just one). */
export function FundsTabs({ active, funds, rules }: { active: Tab; funds: boolean; rules: boolean }) {
  if (!funds || !rules) return null;
  const tab = (key: Tab, href: string, label: string) => (
    <Link
      href={href}
      className={`border-b-2 pb-1 hover:no-underline ${active === key ? "border-accent font-bold text-text" : "border-transparent text-muted hover:text-text"}`}
    >
      {label}
    </Link>
  );
  return (
    <nav className="mb-6 flex gap-6 border-b border-border text-sm" aria-label="Funds">
      {tab("funds", "/funds", "Label funds")}
      {tab("rules", "/rules", "Rules")}
    </nav>
  );
}
