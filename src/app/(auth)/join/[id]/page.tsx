import Link from "next/link";
import { JoinBandForm } from "@/components/auth-forms";
import { LinkButton } from "@/components/ui";
import { hasSharedLogin, unclaimedMembers, usableInviteLink } from "@/server/band-invite-links";
import { getSession } from "@/server/context";
import { signOut } from "@/server/account-actions";

export const metadata = { title: "join" };

/**
 * An invite link to a band's account (see band-invite-links.ts): sign in or sign up with any email,
 * then join. As a member (the link names one), the login is theirs; otherwise it's the band's.
 */
export default async function JoinPage({ params, searchParams }: PageProps<"/join/[id]">) {
  const id = (await params).id;
  const [found, session] = await Promise.all([usableInviteLink(id), getSession()]);
  if (!found) {
    return (
      <>
        <h1 className="mb-2 text-xl font-bold">This invite link doesn’t work</h1>
        <p className="text-sm text-muted">It has been used, cancelled or has expired. Ask whoever sent it for a new one.</p>
      </>
    );
  }
  const { band, personName, labelName } = found;
  // Back here after signing up or in, joining by itself.
  const after = `/join/${id}?go=1`;
  // A new login is named for the member the link names, else the band (they say who they are next).
  const name = personName ?? band.name;
  return (
    <>
      <h1 className="mb-2 text-xl font-bold">Join {band.name}</h1>
      <p className="mb-5 text-sm text-muted">
        {personName ? `Sign in as ${personName}` : session ? "Say who you are in the band" : "Sign in or create a login, then say who you are in the band"}
        {labelName ? `, to see what ${labelName} has for ${personName ? "the band" : "you"}.` : "."}
      </p>
      {session && (
        // Which login is joining, and what it gets: a chance to use another one first.
        <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded border border-border px-3 py-2 text-sm">
          <span>
            Signed in as <b>{session.user.email}</b>. This adds <b>{band.name}</b>
            {labelName ? ` (${labelName})` : ""} to that login.
          </span>
          <form action={signOut}>
            <input type="hidden" name="next" value={`/join/${id}`} />
            <button type="submit" className="cursor-pointer text-(--link) hover:underline">
              Use a different login
            </button>
          </form>
        </div>
      )}
      {session ? (
        <JoinBandForm
          id={id}
          bandName={band.name}
          members={found.link.personId ? null : await unclaimedMembers(band.id, found.labelOrgId, found.bandId)}
          sharedTaken={await hasSharedLogin(band.id)}
          auto={(await searchParams).go === "1"}
          email={session.user.email}
        />
      ) : (
        <div className="space-y-3">
          <LinkButton href={`/signup?next=${encodeURIComponent(after)}&name=${encodeURIComponent(name)}`} variant="primary" className="w-full">
            Create a login
          </LinkButton>
          <p className="text-center text-sm text-muted">
            Already have one? <Link href={`/login?next=${encodeURIComponent(after)}`}>Sign in</Link>
          </p>
        </div>
      )}
    </>
  );
}
