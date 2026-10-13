import { after } from "next/server";
import { ReadOnly } from "@/components/client";
import { Nav } from "@/components/nav";
import { ViewingAsBar } from "@/components/viewing-as";
import { onCloudflare } from "@/db";
import { AREAS, can } from "@/lib/permissions";
import { syncAccount, syncStatus } from "@/server/auto-sync";
import { getContext } from "@/server/context";
import { labelsForBandAccount } from "@/server/links";
import { projectsEnabled } from "@/server/features";
import { navBadges } from "@/server/nav-badges";
import { isSiteAdminEmail } from "@/server/site-admin";

/** Everything you see once signed in: the nav (with your accounts), then the page. */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const ctx = await getContext();
  const [labels, sync, badges, projects] = await Promise.all([
    // A band account's admins see each label it's linked to.
    ctx.isAdmin && ctx.org.kind === "band" ? labelsForBandAccount(ctx.orgId) : [],
    syncStatus(ctx.orgId),
    ctx.viewingAs ? {} : navBadges(ctx),
    projectsEnabled(),
  ]);

  // Locally, opening the app keeps it in step with Bandcamp: at most once an hour, in the background,
  // after the page has been sent. Not on Cloudflare: its hourly cron does that, and Workers cancel
  // background work about 30 seconds after the response, which cut these syncs off halfway.
  const due = !onCloudflare && !!sync?.due && !ctx.viewingAs;
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
      {ctx.viewingAs && <ViewingAsBar viewing={ctx.viewingAs} />}
      <Nav
        user={{ name: ctx.user.name, email: ctx.user.email }}
        managed={!!ctx.managedBy}
        viewing={!!ctx.viewingAs}
        account={ctx.org}
        accounts={ctx.accounts}
        isAdmin={ctx.isAdmin}
        areas={AREAS.filter((a) => can(ctx.access, a.key)).map((a) => a.key)}
        badges={badges}
        siteAdmin={isSiteAdminEmail(ctx.user.email)}
        projects={projects}
        // On the live site the admin dashboard has its own address (admin.labelmaker.ing) and no link
        // here; locally it's at /admin.
        showAdminLink={!process.env.ADMIN_URL}
        syncing={due || !!sync?.running}
        labels={labels.map(({ link, label }) => ({ href: `/from-label/${link.id}`, label: `from ${label.name}` }))}
      />
      <main className="min-w-0 flex-1 px-4 py-8 md:px-8">
        <div className="mx-auto max-w-5xl">
          {ctx.viewingAs ? <ReadOnly reason={`You’re viewing as ${ctx.viewingAs.name}: nothing can be changed.`}>{children}</ReadOnly> : children}
        </div>
      </main>
      {/* <footer className="no-print border-t border-border px-4 py-5 text-center text-xs text-muted">
        labelmaker · an independent tool for indie labels, not affiliated with or endorsed by Bandcamp
      </footer> */}
    </>
  );
}
