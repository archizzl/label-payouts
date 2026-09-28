import { Nav } from "@/components/nav";
import { getContext } from "@/server/context";

/** Everything you see once signed in: the nav (with your accounts), then the page. */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const ctx = await getContext();
  return (
    <>
      <Nav
        user={{ name: ctx.user.name, email: ctx.user.email }}
        account={ctx.org}
        accounts={ctx.accounts}
        isAdmin={ctx.isAdmin}
      />
      <main className="min-w-0 flex-1 px-4 py-8 md:px-8">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
      <footer className="no-print border-t border-border px-4 py-5 text-center text-xs text-muted">labels for bandcamp</footer>
    </>
  );
}
