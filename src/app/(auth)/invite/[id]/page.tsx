import { eq } from "drizzle-orm";
import Link from "next/link";
import { AcceptInviteForm } from "@/components/auth-forms";
import { db, schema } from "@/db";
import { getSession } from "@/server/context";
import { normalizeEmail } from "@/server/people";

/** Someone was invited to a label or band account: sign up or in with that email, then accept. */
export default async function InvitePage({ params }: PageProps<"/invite/[id]">) {
  const { id } = await params;
  const [row] = await db
    .select({ invite: schema.invitation, org: schema.organization, inviter: schema.user })
    .from(schema.invitation)
    .innerJoin(schema.organization, eq(schema.invitation.organizationId, schema.organization.id))
    .innerJoin(schema.user, eq(schema.invitation.inviterId, schema.user.id))
    .where(eq(schema.invitation.id, id));
  if (!row || row.invite.status !== "pending" || row.invite.expiresAt < new Date()) {
    return (
      <>
        <h1 className="mb-2 text-xl font-bold">Invite not found</h1>
        <p className="text-sm text-muted">This invite has been used, cancelled or has expired. Ask whoever sent it for a new one.</p>
      </>
    );
  }
  const { invite, org, inviter } = row;
  const session = await getSession();
  const here = `/invite/${id}`;
  const q = (path: string) => `${path}?next=${encodeURIComponent(here)}&email=${encodeURIComponent(invite.email)}`;
  return (
    <>
      <h1 className="mb-2 text-xl font-bold">Join {org.name}</h1>
      <p className="mb-5 text-sm text-muted">
        {inviter.name} invited {invite.email} to the {org.kind === "band" ? "band" : "label"} <b>{org.name}</b>
        {invite.role === "admin" ? " as an admin, to help manage it" : ", to see your earnings and payouts"}.
      </p>
      {!session ? (
        <div className="space-y-2">
          <Link href={q("/signup")} className="block">
            Create a login with {invite.email}
          </Link>
          <Link href={q("/login")} className="block">
            I already have a login
          </Link>
        </div>
      ) : normalizeEmail(session.user.email) !== normalizeEmail(invite.email) ? (
        <p className="text-sm text-bad">
          You’re signed in as {session.user.email}, but this invite is for {invite.email}. Sign out and sign in with that email.
        </p>
      ) : (
        <AcceptInviteForm id={id} />
      )}
    </>
  );
}
