import Link from "next/link";
import { redirect } from "next/navigation";
import { CreateAccountForm } from "@/components/auth-forms";
import { accountsFor, getSession } from "@/server/context";

/** After signing up: set up a label or band account (or, if you were invited, accept the invite). */
export default async function WelcomePage() {
  const session = await getSession();
  if (!session) redirect("/login?next=/welcome");
  const accounts = await accountsFor(session.user.id);
  return (
    <>
      <h1 className="mb-1 text-xl font-bold">Welcome, {session.user.name.split(" ")[0]}</h1>
      <p className="mb-5 text-sm text-muted">
        Set up your label or band. If someone invited you to theirs, open the invite link they sent instead.
      </p>
      <CreateAccountForm />
      {accounts.length > 0 && (
        <p className="mt-5 text-sm text-muted">
          <Link href="/">Back to {accounts[0].name}</Link>
        </p>
      )}
    </>
  );
}
