import { and, eq, gt, sql } from "drizzle-orm";
import Link from "next/link";
import { signOut } from "@/server/account-actions";
import { redirect } from "next/navigation";
import { CreateAccountForm } from "@/components/auth-forms";
import { DeleteLogin } from "@/components/delete-login";
import { db, schema } from "@/db";
import { accountsFor, getSession } from "@/server/context";

export const metadata = { title: "welcome" };

/** After signing up: set up a label or band account, or open an invite into someone else's. */
export default async function WelcomePage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/welcome");
  const { user } = session;
  const [accounts, invites] = await Promise.all([
    accountsFor(user.id),
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

      <p className="mb-5 text-sm text-muted">Set up your label or band.</p>
      <CreateAccountForm />

      <div className="mt-5 flex flex-wrap items-center gap-4 text-sm text-muted">
        {accounts.length > 0 && <Link href="/">Back to {accounts[0].name}</Link>}
        <form action={signOut} className="ml-auto">
          <span className="mr-1">Signed in as {user.email}.</span>
          <button type="submit" className="text-link hover:underline">
            Sign out
          </button>
        </form>
      </div>

      {/* In no account any more (all left or deleted): Account isn't reachable, so deleting the login is here. */}
      {accounts.length === 0 && (
        <details className="mt-5 border-t border-border pt-4 text-sm">
          <summary className="cursor-pointer text-muted">Delete my account</summary>
          <div className="mt-3">
            <DeleteLogin email={user.email} accounts={0} sole={[]} bare />
          </div>
        </details>
      )}
    </div>
  );
}
