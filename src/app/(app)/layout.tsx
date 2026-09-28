import { Nav } from "@/components/nav";
import { getContext } from "@/server/context";
import { labelsForBandAccount } from "@/server/links";

/** Everything you see once signed in: the nav (with your accounts), then the page. */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const ctx = await getContext();
  // A band account's admins see each label it's linked to.
  const labels = ctx.isAdmin && ctx.org.kind === "band" ? await labelsForBandAccount(ctx.orgId) : [];
  return (
    <>
      <Nav
        user={{ name: ctx.user.name, email: ctx.user.email }}
        account={ctx.org}
        accounts={ctx.accounts}
        isAdmin={ctx.isAdmin}
        labels={labels.map(({ link, label }) => ({ href: `/from-label/${link.id}`, label: `from ${label.name}` }))}
      />
      <main className="min-w-0 flex-1 px-4 py-8 md:px-8">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
      <footer className="no-print border-t border-border px-4 py-5 text-center text-xs text-muted">labels for bandcamp</footer>
    </>
  );
}
