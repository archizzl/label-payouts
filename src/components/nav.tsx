"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef } from "react";
import { signOut, switchAccount } from "@/server/account-actions";
import type { Account } from "@/server/context";

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

function itemsFor(account: Account, isAdmin: boolean) {
  if (!isAdmin) return [{ href: "/me", label: "my earnings" }];
  return [
    { href: "/", label: "dashboard" },
    { href: "/import", label: "import sales" },
    { href: "/periods", label: "payouts" },
    { href: "/bands", label: account.kind === "band" ? "band" : "bands" },
    { href: "/people", label: "people" },
    { href: "/catalog", label: "catalog" },
    { href: "/rules", label: account.kind === "band" ? "rules" : "label rules" },
    { href: "/me", label: "my earnings" },
    { href: "/account", label: "settings" },
  ];
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
}: {
  user: { name: string; email: string };
  account: Account;
  accounts: Account[];
  isAdmin: boolean;
}) {
  const path = usePathname();
  const items = itemsFor(account, isAdmin);
  return (
    <header className="no-print border-b border-border bg-surface">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-4 pb-3 md:px-8">
        <Link href="/" className="flex items-center gap-2 text-text hover:no-underline">
          <Mark />
          <span className="text-xl font-bold tracking-tight lowercase">labels for bandcamp</span>
        </Link>
        <div className="flex flex-wrap items-center gap-3">
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
