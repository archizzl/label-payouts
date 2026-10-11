"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useState } from "react";
import {
  Banknote,
  Boxes,
  ChartColumn,
  Disc3,
  FolderKanban,
  LayoutDashboard,
  Link2,
  LogOut,
  type LucideIcon,
  Menu,
  Music,
  Package,
  PiggyBank,
  ReceiptText,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  Wallet,
  X,
} from "lucide-react";
import type { Area } from "@/lib/permissions";
import { signOut, switchAccount } from "@/server/account-actions";
import type { Account } from "@/server/context";
import { SyncIndicator } from "./sync-indicator";

/** A small record, our own mark. */
export function Mark() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6 shrink-0" aria-hidden>
      <circle cx="12" cy="12" r="11" fill="var(--accent)" />
      <circle cx="12" cy="12" r="7.5" fill="none" stroke="var(--accent-fg)" strokeOpacity="0.35" strokeWidth="0.8" />
      <circle cx="12" cy="12" r="3.2" fill="var(--accent-fg)" />
      <circle cx="12" cy="12" r="1" fill="var(--accent)" />
    </svg>
  );
}

type Item = { href: string; label: string };

function itemsFor(account: Account, isAdmin: boolean, areas: Area[], labels: Item[], projects: boolean): Item[] {
  const all: (Item & { area?: Area })[] = [
    { href: "/", label: "Dashboard", area: "dashboard" },
    { href: "/sales", label: "Sales", area: "sales" },
    { href: "/orders", label: "Orders", area: "orders" },
    { href: "/inventory", label: "Inventory", area: "inventory" },
    { href: "/periods", label: "Payouts", area: "payouts" },
    ...(account.kind === "label" ? [{ href: "/funds", label: "Label funds", area: "funds" as const }] : []),
    { href: "/receipts", label: "Receipts", area: "receipts" },
    { href: "/bands", label: account.kind === "band" ? "Band" : "Bands", area: "roster" },
    { href: "/people", label: "People", area: "roster" },
    // { href: "/fans", label: "Fans", area: "fans" },
    { href: "/catalog", label: "Catalog", area: "catalog" },
    { href: "/rules", label: account.kind === "band" ? "Rules" : "Label rules", area: "rules" },
  ];
  if (isAdmin) return [...all, ...(projects ? [{ href: "/projects", label: "Projects" }] : []), ...labels, { href: "/account", label: "Settings" }];
  // Members: their own earnings, plus whatever their member type lets them see.
  return [{ href: "/me", label: "My earnings" }, ...all.filter((i) => i.area && areas.includes(i.area))];
}

const ICONS: Record<string, LucideIcon> = {
  "/": LayoutDashboard,
  "/sales": ChartColumn,
  "/orders": Package,
  "/inventory": Boxes,
  "/periods": Banknote,
  "/funds": PiggyBank,
  "/receipts": ReceiptText,
  "/bands": Music,
  "/people": Users,
  "/catalog": Disc3,
  "/rules": SlidersHorizontal,
  "/projects": FolderKanban,
  "/account": Settings,
  "/me": Wallet,
  "/admin": ShieldCheck,
};

/** Pick which of your accounts (labels and bands) you're working in. */
function AccountSwitcher({ account, accounts }: { account: Account; accounts: Account[] }) {
  const form = useRef<HTMLFormElement>(null);
  if (accounts.length < 2) {
    return (
      <div className="rounded-lg bg-surface-2 px-3 py-2 text-sm">
        <div className="truncate font-semibold">{account.name}</div>
        <div className="text-xs text-muted capitalize">{account.kind} account</div>
      </div>
    );
  }
  return (
    <form ref={form} action={switchAccount}>
      <select
        name="orgId"
        defaultValue={account.id}
        aria-label="Account"
        className="!rounded-lg !bg-surface-2 !py-2 text-sm font-semibold"
        onChange={() => form.current?.requestSubmit()}
      >
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} ({a.kind})
          </option>
        ))}
      </select>
    </form>
  );
}

/**
 * The app's navigation: a sidebar on wider screens (wordmark, account, sections with their numbers,
 * you), and a top bar with a menu on phones.
 */
export function Nav({
  user,
  account,
  accounts,
  isAdmin,
  areas = [],
  badges = {},
  labels = [],
  syncing = false,
  siteAdmin = false,
}: {
  user: { name: string; email: string };
  account: Account;
  accounts: Account[];
  isAdmin: boolean;
  /** For members: the sections their member type lets them see. */
  areas?: Area[];
  /** Numbers on sections: orders to ship, new sales, receipts to approve. */
  badges?: Partial<Record<"orders" | "sales" | "receipts", number>>;
  /** Band accounts: a link to each label they're linked to. */
  labels?: Item[];
  /** A background sync with Bandcamp is running (or about to). */
  syncing?: boolean;
  /** Runs the whole site: gets the Admin link. */
  siteAdmin?: boolean;
}) {
  const path = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  // Close the phone menu whenever the page changes.
  const [menuPath, setMenuPath] = useState(path);
  if (menuPath !== path) {
    setMenuPath(path);
    setMenuOpen(false);
  }
  // "New sales" counts from your last look at Sales: once you've opened it, stop showing the number
  // (the navigation isn't reloaded on every click, so it would otherwise linger).
  const [seenSales, setSeenSales] = useState(false);
  if (path === "/sales" && !seenSales) setSeenSales(true);
  const countFor = (href: string) => {
    const key = href.slice(1) as "orders" | "sales" | "receipts";
    if (key === "sales" && seenSales) return 0;
    return badges[key] ?? 0;
  };
  const items = [...itemsFor(account, isAdmin, areas, labels, siteAdmin), ...(siteAdmin ? [{ href: "/admin", label: "Admin" }] : [])];

  const links = (
    <ul className="space-y-0.5">
      {items.map((it) => {
        const active = it.href === "/" ? path === "/" : path.startsWith(it.href);
        const n = countFor(it.href);
        const what = { "/orders": "to ship or hand over", "/sales": "new", "/receipts": "to approve" }[it.href] ?? "";
        const Icon = ICONS[it.href] ?? (it.href.startsWith("/from-label") ? Link2 : LayoutDashboard);
        return (
          <li key={it.href}>
            <Link
              href={it.href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:no-underline ${
                active ? "bg-accent/10 font-semibold text-accent" : "text-text hover:bg-surface-2"
              }`}
            >
              <Icon className={`h-[18px] w-[18px] shrink-0 ${active ? "" : "text-muted"}`} strokeWidth={1.8} aria-hidden />
              <span className="flex-1 truncate">{it.label}</span>
              {n > 0 && (
                <span
                  className="min-w-[1.25rem] rounded-full bg-accent px-1.5 text-center text-[11px] leading-5 font-bold text-accent-fg tabular-nums"
                  title={`${n} ${what}`}
                  aria-label={`${n} ${what}`}
                >
                  {n > 99 ? "99+" : n}
                </span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
  const you = (
    <div className="flex items-center gap-3 border-t border-border pt-4">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{user.name}</div>
        <div className="truncate text-xs text-muted">{user.email}</div>
      </div>
      <form action={signOut}>
        <button type="submit" className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-text" title="Sign out" aria-label="Sign out">
          <LogOut className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden />
        </button>
      </form>
    </div>
  );
  const wordmark = (
    <Link href="/" className="flex items-center gap-2 text-text hover:no-underline">
      <Mark />
      <span className="font-brand text-[22px] font-bold tracking-tight lowercase">labelmaker</span>
    </Link>
  );

  return (
    <>
      {/* Wider screens: a sidebar. */}
      <aside className="no-print sticky top-0 hidden h-screen w-64 shrink-0 flex-col gap-5 overflow-y-auto border-r border-border bg-surface px-4 py-5 md:flex">
        <div className="px-1">{wordmark}</div>
        <AccountSwitcher account={account} accounts={accounts} />
        <SyncIndicator active={syncing} />
        <nav className="flex-1" aria-label="Sections">
          {links}
        </nav>
        {you}
      </aside>

      {/* Phones: a top bar, and the same sections in a menu. */}
      <header className="no-print sticky top-0 z-20 flex items-center justify-between border-b border-border bg-surface px-4 py-3 md:hidden">
        {wordmark}
        <button
          type="button"
          className="rounded-lg p-2 hover:bg-surface-2"
          aria-expanded={menuOpen}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          onClick={() => setMenuOpen((o) => !o)}
        >
          {menuOpen ? <X className="h-5 w-5" aria-hidden /> : <Menu className="h-5 w-5" aria-hidden />}
        </button>
      </header>
      {menuOpen && (
        <div className="no-print fixed inset-x-0 top-[57px] bottom-0 z-20 space-y-4 overflow-y-auto bg-surface px-4 py-4 md:hidden">
          <AccountSwitcher account={account} accounts={accounts} />
          <SyncIndicator active={syncing} />
          <nav aria-label="Sections">{links}</nav>
          {you}
        </div>
      )}
    </>
  );
}
