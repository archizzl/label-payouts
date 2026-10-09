import { after } from "next/server";
import { Nav } from "@/components/nav";
import { onCloudflare } from "@/db";
import { AREAS, can } from "@/lib/permissions";
import { syncAccount, syncStatus } from "@/server/auto-sync";
import { getContext } from "@/server/context";
import { labelsForBandAccount } from "@/server/links";
import { isSiteAdminEmail } from "@/server/site-admin";

/** Everything you see once signed in: the nav (with your accounts), then the page. */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const ctx = await getContext();
  // A band account's admins see each label it's linked to.
  const labels = ctx.isAdmin && ctx.org.kind === "band" ? await labelsForBandAccount(ctx.orgId) : [];

  // Locally, opening the app keeps it in step with Bandcamp: at most once an hour, in the background,
  // after the page has been sent. Not on Cloudflare: its hourly cron does that, and Workers cancel
  // background work about 30 seconds after the response, which cut these syncs off halfway.
  const sync = await syncStatus(ctx.orgId);
  const due = !onCloudflare && !!sync?.due;
  if (due) {
    const orgId = ctx.orgId;
    after(() =>
      syncAccount(orgId).catch((e) => {
        console.error(`Background Bandcamp sync failed for ${orgId}:`, e);
      }),
    );
  }
  return (
    <>
      <Nav
        user={{ name: ctx.user.name, email: ctx.user.email }}
        account={ctx.org}
        accounts={ctx.accounts}
        isAdmin={ctx.isAdmin}
        areas={AREAS.filter((a) => can(ctx.access, a.key)).map((a) => a.key)}
        siteAdmin={isSiteAdminEmail(ctx.user.email)}
        syncing={due || !!sync?.running}
        labels={labels.map(({ link, label }) => ({ href: `/from-label/${link.id}`, label: `from ${label.name}` }))}
      />
      <main className="min-w-0 flex-1 px-4 py-8 md:px-8">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
      <footer className="no-print border-t border-border px-4 py-5 text-center text-xs text-muted">labels for bandcamp</footer>
    </>
  );
}
