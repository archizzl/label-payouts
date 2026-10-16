import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { AcceptInviteForm } from "@/components/auth-forms";
import { buttonClass, LinkButton } from "@/components/ui";
import { signOut } from "@/server/account-actions";
import { db, schema } from "@/db";
import { getSession } from "@/server/context";
import { normalizeEmail } from "@/server/people";

export const metadata = { title: "invite" };

/** Someone was invited to a label or band account: sign up or in with that email, then accept. */
export default async function InvitePage({ params, searchParams }: PageProps<"/invite/[id]">) {
  const { id } = await params;
  // Back here straight after creating a login for this invite: accept it without another click.
  const justSignedUp = (await searchParams).joined === "1";
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
  const [session, [person], [fromLabel]] = await Promise.all([
    getSession(),
    // Who the account knows them as, so they needn't type their name.
    invite.personId
      ? db
          .select({ name: schema.people.name })
          .from(schema.people)
          .where(and(eq(schema.people.orgId, org.id), eq(schema.people.id, invite.personId)))
      : [],
    // A band's account the label made for it.
    db
      .select({ labelName: schema.organization.name, labelOrgId: schema.accountLinks.labelOrgId })
      .from(schema.accountLinks)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.accountLinks.labelOrgId))
      .where(and(eq(schema.accountLinks.bandOrgId, org.id), eq(schema.accountLinks.managed, true))),
  ]);
  // Who they are, so they needn't type a name: the person they were invited as, or, for a band's
  // account from its label (one login the whole band shares), the band.
  const known = person ?? (fromLabel ? { name: org.name } : undefined);
  const q = (path: string, after: string) =>
    `${path}?next=${encodeURIComponent(after)}&email=${encodeURIComponent(invite.email)}${known ? `&name=${encodeURIComponent(known.name)}` : ""}`;
  return (
    <>
      <h1 className="mb-2 text-xl font-bold">Join {org.name}</h1>
      <p className="mb-5 text-sm text-muted">
        {fromLabel ? (
          <>
            {inviter.name} at {fromLabel.labelName} invited {invite.email} to <b>{org.name}</b>, to see your earnings and the
            band’s sales, payouts and statements from {fromLabel.labelName}.
          </>
        ) : (
          <>
            {inviter.name} invited {invite.email} to the {org.kind === "band" ? "band" : "label"} <b>{org.name}</b>
            {invite.role === "admin" ? " as an admin, to help manage it" : ", to see your earnings and payouts"}.
          </>
        )}
      </p>
      {!session ? (
        <div className="space-y-3">
          <LinkButton href={q("/signup", `/invite/${id}?joined=1`)} variant="primary" className="w-full">
            Create an account
          </LinkButton>
          <p className="text-center text-sm text-muted">
            Already have one? <Link href={q("/login", `/invite/${id}?joined=1`)}>Sign in</Link>
          </p>
        </div>
      ) : normalizeEmail(session.user.email) !== normalizeEmail(invite.email) ? (
        <div className="space-y-3 text-sm">
          <p className="text-bad">
            You’re signed in as {session.user.email}, but this invite is for {invite.email}. Sign out, then sign in or create a login with
            that email.
          </p>
          <form action={signOut}>
            <button type="submit" className={buttonClass("secondary")}>
              Sign out
            </button>
          </form>
        </div>
      ) : (
        <AcceptInviteForm id={id} auto={justSignedUp} />
      )}
    </>
  );
}
