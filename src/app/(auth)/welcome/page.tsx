import { and, eq, gt, sql } from "drizzle-orm";
import Link from "next/link";
import { signOut } from "@/server/account-actions";
import { redirect } from "next/navigation";
import { ApplicationForm } from "@/components/application-form";
import { CreateAccountForm } from "@/components/auth-forms";
import { db, schema } from "@/db";
import { latestApplication, preapproved } from "@/server/applications";
import { accountsFor, getSession } from "@/server/context";
import { isSiteAdminEmail } from "@/server/site-admin";

export const metadata = { title: "welcome" };

/**
 * After signing up: apply for a label or band account (a site admin approves it), see how that's
 * going, or open an invite into someone else's account. Site admins, and people who signed up with
 * a site admin's invite link, set an account up straight away.
 */
export default async function WelcomePage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/welcome");
  const { user } = session;
  const [accounts, application, direct, invites] = await Promise.all([
    accountsFor(user.id),
    latestApplication(user.id),
    isSiteAdminEmail(user.email) ? true : preapproved(user.id),
    db
      .select({ id: schema.invitation.id, org: schema.organization.name })
      .from(schema.invitation)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.invitation.organizationId))
      .where(and(sql`lower(${schema.invitation.email}) = ${user.email.toLowerCase()}`, eq(schema.invitation.status, "pending"), gt(schema.invitation.expiresAt, new Date()))),
  ]);
  const first = user.name.split(" ")[0];

  return (
    <div className="wide">
      <h1 className="mb-1 text-xl font-bold">Welcome, {first}</h1>

      {invites.length > 0 && (
        <div className="mb-5 rounded-md border border-border bg-surface-2 p-3 text-sm">
          You’ve been invited to{" "}
          {invites.map((i, n) => (
            <span key={i.id}>
              {n > 0 && ", "}
              <Link href={`/invite/${i.id}`}>{i.org}</Link>
            </span>
          ))}
          . Open the invite to join.
        </div>
      )}

      {direct ? (
        <>
          <p className="mb-5 text-sm text-muted">Set up your label or band.</p>
          <CreateAccountForm />
        </>
      ) : application?.status === "pending" ? (
        <div className="space-y-2 text-sm">
          <p>
            Thanks! We’re looking at your application for <b>{application.name}</b> ({application.kind}), sent{" "}
            {application.createdAt.slice(0, 10)}.
          </p>
          <p className="text-muted">
            Once it’s approved, your account is set up here
            {application.kind === "band" ? " with your band and its members" : " with your artists"}. Sign in again any time to check.
          </p>
        </div>
      ) : (
        <>
          {application?.status === "rejected" && (
            <div className="mb-5 rounded-md border border-bad/30 bg-bad-bg p-3 text-sm text-bad">
              Your application for <b>{application.name}</b> wasn’t approved{application.reviewNote ? `: ${application.reviewNote}` : "."} You can
              apply again below.
            </div>
          )}
          <p className="mb-5 text-sm text-muted">
            Tell us about your band or label. We review each one, then set your account up with what you tell us here.
            {invites.length > 0 && " (Or open your invite above to join an account that already exists.)"}
          </p>
          <ApplicationForm yourName={user.name} />
        </>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-4 text-sm text-muted">
        {accounts.length > 0 && <Link href="/">Back to {accounts[0].name}</Link>}
        <form action={signOut} className="ml-auto">
          <span className="mr-1">Signed in as {user.email}.</span>
          <button type="submit" className="text-link hover:underline">
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
