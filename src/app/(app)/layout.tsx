import { headers } from "next/headers";
import { after } from "next/server";
import { FixSignIn } from "@/components/fix-sign-in";
import { hasDuplicateSession } from "@/lib/auth-cookies";
import { ReadOnly } from "@/components/client";
import { Nav } from "@/components/nav";
import { ViewingAsBar } from "@/components/viewing-as";
import { onCloudflare } from "@/db";
import { AREAS, can } from "@/lib/permissions";
import { syncAccount, syncStatus } from "@/server/auto-sync";
import { catalogSyncProgress, catalogSyncRequestedAt } from "@/server/catalog-requests";
import { getContext, groupPhotos, isBandLogin } from "@/server/context";
import { ownBand } from "@/server/data";
import { labelsForBandAccount } from "@/server/links";
import { featureOn, projectsEnabled } from "@/server/features";
import { abelConfigured } from "@/server/abel/config";
import { AbelPanel } from "@/components/abel/abel-panel";
import { navBadges, ordersInUse } from "@/server/nav-badges";
import { isSiteAdminEmail } from "@/server/site-admin";

/** Everything you see once signed in: the nav (with your accounts), then the page. */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const ctx = await getContext();
  // What syncs with Bandcamp: the account's own books (for a band account the label made too).
  const syncOrgId = ctx.managedBy ? ctx.org.id : ctx.orgId;
  const [labels, sync, badges, projects, band, orders, catalogAsked, catalogProgress, photos, abel] = await Promise.all([
    // A band account's admins see each label it's linked to (one the label made has it all on its own pages).
    ctx.isAdmin && ctx.org.kind === "band" && !ctx.managedBy ? labelsForBandAccount(ctx.orgId) : [],
    syncStatus(syncOrgId),
    ctx.viewingAs ? {} : navBadges(ctx),
    projectsEnabled(),
    ctx.org.kind === "band" ? ownBand(ctx.org.id) : null,
    ordersInUse(ctx.orgId),
    ctx.viewingAs ? null : catalogSyncRequestedAt(ctx.orgId),
    ctx.viewingAs ? null : catalogSyncProgress(ctx.orgId),
    groupPhotos([ctx.org, ...ctx.accounts]),
    abelConfigured() ? featureOn("abel") : false,
  ]);

  // Locally, opening the app keeps it in step with Bandcamp: at most once an hour, in the background,
  // after the page has been sent. Not on Cloudflare: its hourly cron does that, and Workers cancel
  // background work about 30 seconds after the response, which cut these syncs off halfway.
  const due = !onCloudflare && !!sync?.due && !ctx.viewingAs;
  if (due) {
    const orgId = syncOrgId;
    after(() =>
      syncAccount(orgId).catch((e) => {
        console.error(`Background Bandcamp sync failed for ${orgId}:`, e);
      }),
    );
  }
  const staleCookie = hasDuplicateSession((await headers()).get("cookie"));
  return (
    <>
      {staleCookie && <FixSignIn />}
      {ctx.viewingAs && <ViewingAsBar viewing={ctx.viewingAs} />}
      <Nav
        user={{ name: ctx.user.name, email: ctx.user.email, image: ctx.user.image ?? null }}
        managed={ctx.lens ? "/" : null}
        bandLogin={isBandLogin(ctx)}
        earnings={!ctx.managedBy && !!ctx.person}
        bandHref={band ? `/bands/${band.id}` : null}
        hideOrders={!orders.inUse}
        viewing={!!ctx.viewingAs}
        account={ctx.org}
        accounts={ctx.accounts}
        groupPhotos={Object.fromEntries(photos)}
        // A band login is an admin of its own small account (settings), not of the label's books.
        isAdmin={ctx.lens ? ctx.org.role !== "member" : ctx.isAdmin}
        areas={AREAS.filter((a) => can(ctx.access, a.key)).map((a) => a.key)}
        badges={badges}
        siteAdmin={isSiteAdminEmail(ctx.user.email)}
        projects={projects}
        // On the live site the admin dashboard has its own address (admin.labelmaker.ing) and no link
        // here; locally it's at /admin.
        showAdminLink={!process.env.ADMIN_URL}
        syncing={due || !!sync?.running}
        syncedAt={sync?.finishedAt ?? null}
        catalogBusy={!!catalogAsked || !!catalogProgress}
        labels={labels.map(({ link, label }) => ({ href: `/from-label/${link.id}`, label: `from ${label.name}` }))}
      />
      <main className="min-w-0 flex-1 px-4 py-8 md:px-8">
        <div className="mx-auto max-w-5xl">
          {ctx.viewingAs ? <ReadOnly reason={`You’re viewing as ${ctx.viewingAs.name}: nothing can be changed.`}>{children}</ReadOnly> : children}
        </div>
      </main>
      {abel && <AbelPanel />}
      {/* <footer className="no-print border-t border-border px-4 py-5 text-center text-xs text-muted">
        labelmaker · an independent tool for indie labels, not affiliated with or endorsed by Bandcamp
      </footer> */}
    </>
  );
}
