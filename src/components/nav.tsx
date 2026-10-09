"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef } from "react";
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

function itemsFor(account: Account, isAdmin: boolean, areas: Area[], labels: Item[]): Item[] {
  const all: (Item & { area?: Area })[] = [
    { href: "/", label: "dashboard", area: "dashboard" },
    { href: "/sales", label: "sales", area: "sales" },
    { href: "/orders", label: "orders", area: "orders" },
    { href: "/periods", label: "payouts", area: "payouts" },
    ...(account.kind === "label" ? [{ href: "/funds", label: "label funds", area: "funds" as const }] : []),
    { href: "/receipts", label: "receipts", area: "receipts" },
    // { href: "/projects", label: "projects" },
    { href: "/bands", label: account.kind === "band" ? "band" : "bands", area: "roster" },
    { href: "/people", label: "people", area: "roster" },
    // { href: "/fans", label: "fans", area: "fans" },
    { href: "/catalog", label: "catalog", area: "catalog" },
    { href: "/rules", label: account.kind === "band" ? "rules" : "label rules", area: "rules" },
  ];
  if (isAdmin) return [...all, ...labels, { href: "/account", label: "settings" }];
  // Members: their own earnings, plus whatever their member type lets them see.
  return [{ href: "/me", label: "my earnings" }, ...all.filter((i) => i.area && areas.includes(i.area))];
}

/** Pick which of your accounts (labels and bands) you're working in. */
function AccountSwitcher({ account, accounts }: { account: Account; accounts: Account[] }) {
  const form = useRef<HTMLFormElement>(null);
  if (accounts.length < 2) {
    return (
      <span className="text-sm text-muted">
        {account.name} <span className="text-xs">({account.kind})</span>
      </span>
    );
  }
  return (
    <form ref={form} action={switchAccount}>
      <select
        name="orgId"
        defaultValue={account.id}
        aria-label="Account"
        className="!w-auto !py-1 text-sm"
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

export function Nav({
  user,
  account,
  accounts,
  isAdmin,
  areas = [],
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
  /** Band accounts: a link to each label they're linked to. */
  labels?: Item[];
  /** A background sync with Bandcamp is running (or about to). */
  syncing?: boolean;
  /** Runs the whole site: gets the Admin link. */
  siteAdmin?: boolean;
}) {
  const path = usePathname();
  const items = [...itemsFor(account, isAdmin, areas, labels), ...(siteAdmin ? [{ href: "/admin", label: "admin" }] : [])];
  return (
    <header className="no-print border-b border-border bg-surface">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-4 pb-3 md:px-8">
        <Link href="/" className="flex items-center gap-2 text-text hover:no-underline">
          <Mark />
          <span className="text-xl font-bold tracking-tight lowercase">labelmaker</span>
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <SyncIndicator active={syncing} />
          <AccountSwitcher account={account} accounts={accounts} />
          <span className="hidden text-sm text-muted sm:inline" title={user.email}>
            {user.name}
          </span>
          <form action={signOut}>
            <button type="submit" className="text-sm text-link hover:underline">
              sign out
            </button>
          </form>
        </div>
      </div>
      <nav className="mx-auto max-w-5xl px-4 md:px-8">
        <ul className="-mb-px flex gap-5 overflow-x-auto">
          {items.map((it) => {
            const active = it.href === "/" ? path === "/" : path.startsWith(it.href);
            return (
              <li key={it.href}>
                <Link
                  href={it.href}
                  className={`block border-b-[3px] pt-1 pb-2 whitespace-nowrap hover:no-underline ${
                    active ? "border-accent font-bold text-text" : "border-transparent text-muted hover:text-text"
                  }`}
                >
                  {it.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </header>
  );
}
