import { Mark } from "@/components/nav";
import { signOut } from "@/server/account-actions";
import { requireSiteAdmin } from "@/server/site-admin";

/**
 * The site admin dashboard (admin.labelmaker.ing): just the admin settings, with none of the app's
 * own navigation. Site admins only; anyone else gets "not found".
 */
export default async function AdminLayout({ children }: LayoutProps<"/">) {
  const session = await requireSiteAdmin();
  const site = process.env.BETTER_AUTH_URL || "/";
  return (
    <>
      <header className="no-print border-b border-border bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-4 md:px-8">
          <div className="flex items-center gap-2">
            <Mark />
            <span className="text-xl font-bold tracking-tight lowercase">labelmaker</span>
            <span className="rounded-sm bg-text px-1.5 py-0.5 text-xs font-bold tracking-wide text-bg uppercase">admin</span>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <a href={site}>Open labelmaker</a>
            <span className="hidden text-muted sm:inline">{session.user.email}</span>
            <form action={signOut}>
              <button type="submit" className="text-link hover:underline">
                sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="min-w-0 flex-1 px-4 py-8 md:px-8">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </>
  );
}
