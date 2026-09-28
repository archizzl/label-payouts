import Link from "next/link";
import { redirect } from "next/navigation";
import { SignUpForm } from "@/components/auth-forms";
import { getSession } from "@/server/context";

export default async function SignupPage({ searchParams }: PageProps<"/signup">) {
  const q = await searchParams;
  const next = typeof q.next === "string" ? q.next : "/welcome";
  if (await getSession()) redirect(next);
  return (
    <>
      <h1 className="mb-1 text-xl font-bold">Create a login</h1>
      <p className="mb-5 text-sm text-muted">For label owners, band members and anyone who gets paid.</p>
      <SignUpForm next={next} email={typeof q.email === "string" ? q.email : undefined} />
      <p className="mt-5 text-sm text-muted">
        Already have one? <Link href={`/login${next !== "/welcome" ? `?next=${encodeURIComponent(next)}` : ""}`}>Sign in</Link>
      </p>
    </>
  );
}
