import Link from "next/link";
import { JoinBandForm } from "@/components/auth-forms";
import { LinkButton } from "@/components/ui";
import { usableInviteLink } from "@/server/band-invite-links";
import { getSession } from "@/server/context";

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
  // A new login is named for who it is: the member, or the band itself.
  const name = personName ?? band.name;
  return (
    <>
      <h1 className="mb-2 text-xl font-bold">Join {band.name}</h1>
      <p className="mb-5 text-sm text-muted">
        {personName ? `Sign in as ${personName}` : `Sign in as ${band.name}`}
        {labelName ? `, to see what ${labelName} has for the band.` : "."}
      </p>
      {session ? (
        <JoinBandForm id={id} label={`Join ${band.name}`} auto={(await searchParams).go === "1"} />
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
