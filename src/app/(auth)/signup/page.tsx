import Link from "next/link";
import { redirect } from "next/navigation";
import { SignUpForm } from "@/components/auth-forms";
import { getSession } from "@/server/context";
import { checkSignup, usableInvite } from "@/server/signup-invites";

/**
 * Creating a login: only with an invite link (/signup?code=…), or for someone invited into an
 * existing account (they arrive from their invite with ?email=…). Anyone else is told it's by invitation.
 */
export default async function SignupPage({ searchParams }: PageProps<"/signup">) {
  const q = await searchParams;
  const next = typeof q.next === "string" ? q.next : "/welcome";
  if (await getSession()) redirect(next);
  const code = typeof q.code === "string" ? q.code : null;
  const invite = code ? await usableInvite(code) : null;
  const email = invite?.email ?? (typeof q.email === "string" ? q.email : undefined);
  // Without a code, only someone invited into an account (by email) can sign up.
  const allowed = invite ? true : !code && email ? (await checkSignup(email, null)).ok : false;
  const signIn = `/login${next !== "/welcome" ? `?next=${encodeURIComponent(next)}` : ""}`;

  if (!allowed) {
    return (
      <>
        <h1 className="mb-2 text-xl font-bold">{code ? "This invite doesn’t work" : "Invitation only"}</h1>
        <p className="mb-5 text-sm text-muted">
          {code
            ? "This invite link has been used, revoked or has expired. Ask whoever sent it for a new one."
            : "Logins are by invitation only. If you’ve been invited, open the link you were sent."}
        </p>
        <p className="text-sm text-muted">
          Already have a login? <Link href={signIn}>Sign in</Link>
        </p>
      </>
    );
  }
  return (
    <>
      <h1 className="mb-1 text-xl font-bold">Create a login</h1>
      <p className="mb-5 text-sm text-muted">For label owners, band members and anyone who gets paid.</p>
      <SignUpForm next={next} email={email} code={invite ? code! : undefined} emailLocked={!!invite?.email || (!invite && !!email)} />
      <p className="mt-5 text-sm text-muted">
        Already have one? <Link href={signIn}>Sign in</Link>
      </p>
    </>
  );
}
