import Link from "next/link";
import { ResetPasswordForm } from "@/components/auth-forms";

/** Choosing a new password from a reset link a site admin sent. */
export default async function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  const q = await searchParams;
  const token = typeof q.token === "string" ? q.token : null;
  if (!token || q.error) {
    return (
      <>
        <h1 className="mb-2 text-xl font-bold">This reset link doesn’t work</h1>
        <p className="mb-5 text-sm text-muted">It may have been used already or expired (they last 24 hours). Ask for a new one.</p>
        <Link href="/login">Back to sign in</Link>
      </>
    );
  }
  return (
    <>
      <h1 className="mb-5 text-xl font-bold">Choose a new password</h1>
      <ResetPasswordForm token={token} />
    </>
  );
}
