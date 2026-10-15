"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useState } from "react";
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

function itemsFor(
  account: Account,
  isAdmin: boolean,
  areas: Area[],
  labels: Item[],
  projects: boolean,
  managed: string | null,
  bandHref: string | null,
  hideOrders: boolean,
): Item[] {
  // A label's sub-account for one of its bands: the label's books, just for the band, and its settings.
  if (managed) {
    return [
      { href: managed, label: "dashboard" },
      { href: "/sales", label: "sales" },
      ...(hideOrders ? [] : [{ href: "/orders", label: "orders" }]),
      { href: "/inventory", label: "inventory" },
      { href: "/periods", label: "payouts" },
      { href: "/funds", label: "funds" },
      { href: "/receipts", label: "receipts" },
      { href: "/catalog", label: "catalog" },
      { href: "/directory", label: "directory" },
      { href: "/account", label: "settings" },
    ];
  }
  const all: (Item & { area?: Area })[] = [
    { href: "/", label: "dashboard", area: "dashboard" },
    { href: "/sales", label: "sales", area: "sales" },
    ...(hideOrders ? [] : [{ href: "/orders", label: "orders", area: "orders" as const }]),
    { href: "/inventory", label: "inventory", area: "inventory" },
    { href: "/periods", label: "payouts", area: "payouts" },
    ...(account.kind === "label" ? [{ href: "/funds", label: "funds", area: "funds" as const }] : []),
    { href: "/receipts", label: "receipts", area: "receipts" },
    // A band account has one band: straight to it. Its money rules are there too, so no Rules tab.
    // A band account's own band, then everyone (bands and people) in the directory.
    ...(account.kind === "band" && bandHref ? [{ href: bandHref, label: "band", area: "roster" as const }] : []),
    { href: "/directory", label: "directory", area: "roster" },
    // { href: "/fans", label: "fans", area: "fans" },
    { href: "/catalog", label: "catalog", area: "catalog" },
    ...(account.kind === "band" ? [] : [{ href: "/rules", label: "rules", area: "rules" as const }]),
  ];
  if (isAdmin) return [...all, ...(projects ? [{ href: "/projects", label: "projects" }] : []), ...labels, { href: "/account", label: "settings" }];
  // Members: their own earnings, plus whatever their member type lets them see.
  return [{ href: "/me", label: "my earnings" }, ...all.filter((i) => i.area && areas.includes(i.area)), { href: "/account", label: "settings" }];
}

/** Pick which of your accounts (labels and bands) you're working in. */
function AccountSwitcher({ account, accounts, bare = false }: { account: Account; accounts: Account[]; bare?: boolean }) {
  const form = useRef<HTMLFormElement>(null);
  if (accounts.length < 2) {
    return (
      <span className="text-sm text-muted">
        {account.name} {!bare && <span className="text-xs">({account.kind})</span>}
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

/** A band account's login that's one member's own: who. */
type NavMember = { name: string } | null;

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
  projects = false,
  showAdminLink = true,
  managed = null,
  viewing = false,
  bandHref = null,
  hideOrders = false,
  member = null,
}: {
  user: { name: string; email: string };
  account: Account;
  accounts: Account[];
  isAdmin: boolean;
  /** For members: the sections their member type lets them see. */
  areas?: Area[];
  /** Numbers on tabs: orders to ship, new sales, receipts to approve. */
  badges?: Partial<Record<"orders" | "sales" | "receipts", number>>;
  /** Band accounts: a link to each label they're linked to. */
  labels?: Item[];
  /** A background sync with Bandcamp is running (or about to). */
  syncing?: boolean;
  /** Runs the whole site: gets the Admin link. */
  siteAdmin?: boolean;
  /** Projects is switched on for them (a flagged feature). */
  projects?: boolean;
  /** Link to the admin dashboard (site admins; not on the live site, where it has its own address). */
  showAdminLink?: boolean;
  /** A band account a label made for one of its bands: its home page (the label's books for it). */
  managed?: string | null;
  /** A label admin viewing as someone else: no switching accounts or signing out from here. */
  viewing?: boolean;
  /** A band account's own band page. */
  bandHref?: string | null;
  /** No Bandcamp API access or pickups yet: the Orders tab would only say how to connect. */
  hideOrders?: boolean;
  /** A label-made band account: its members, and which one is using its shared login. */
  member?: NavMember;
}) {
  const path = usePathname();
  // "New sales" counts from your last look at Sales: once you've opened it, stop showing the number
  // (the header isn't reloaded on every click, so it would otherwise linger).
  const [seenSales, setSeenSales] = useState(false);
  if (path === "/sales" && !seenSales) setSeenSales(true);
  const countFor = (href: string) => {
    const key = href.slice(1) as "orders" | "sales" | "receipts";
    if (key === "sales" && seenSales) return 0;
    return badges[key] ?? 0;
  };
  const items = [...itemsFor(account, isAdmin, areas, labels, projects, managed, bandHref, hideOrders), ...(siteAdmin && showAdminLink && !viewing ? [{ href: "/admin", label: "admin" }] : [])];
  return (
    <header className="no-print border-b border-border bg-surface">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-4 pb-3 md:px-8">
        <Link href="/" className="flex items-center gap-2 text-text hover:no-underline">
          <Mark />
          <span className="text-xl font-bold tracking-tight lowercase">labelmaker</span>
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <SyncIndicator active={syncing} />
          {/* A band's own account is just the band (or, on a member's own login, the band and them). */}
          <AccountSwitcher account={account} accounts={accounts} bare={!!managed} />
          {managed ? (
            member && <span className="hidden text-sm text-muted sm:inline">{member.name}</span>
          ) : (
            <span className="hidden text-sm text-muted sm:inline">{user.name}</span>
          )}
          {!viewing && (
            <form action={signOut}>
              <button type="submit" className="text-sm text-link hover:underline">
                sign out
              </button>
            </form>
          )}
        </div>
      </div>
      <nav className="mx-auto max-w-5xl px-4 md:px-8">
        <ul className="-mb-px flex gap-x-5 overflow-x-auto md:flex-wrap md:overflow-visible">
          {items.map((it) => {
            // A band's own page sits under the directory (unless the nav has a tab for that band).
            const active =
              it.href === "/"
                ? path === "/"
                : path.startsWith(it.href) || (it.href === "/directory" && path.startsWith("/bands/") && !items.some((x) => path.startsWith(x.href) && x.href.startsWith("/bands/")));
            const n = countFor(it.href);
            const what = { "/orders": "to ship or hand over", "/sales": "new", "/receipts": "to approve" }[it.href] ?? "";
            return (
              <li key={it.href}>
                <Link
                  href={it.href}
                  className={`flex items-center gap-1.5 border-b-[3px] pt-1 pb-2 whitespace-nowrap hover:no-underline ${
                    active ? "border-accent font-bold text-text" : "border-transparent text-muted hover:text-text"
                  }`}
                >
                  {it.label}
                  {n > 0 && (
                    <span
                      className="min-w-[1.15rem] rounded-full bg-accent px-1.5 text-center text-[11px] leading-[1.15rem] font-bold text-accent-fg tabular-nums"
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
      </nav>
    </header>
  );
}
