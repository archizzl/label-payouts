import Link from "next/link";
import { redirect } from "next/navigation";
import { SignInForm } from "@/components/auth-forms";
import { getSession } from "@/server/context";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const q = await searchParams;
  const next = typeof q.next === "string" ? q.next : "/";
  if (await getSession()) redirect(next);
  return (
    <>
      <h1 className="mb-5 text-xl font-bold">Sign in</h1>
      <SignInForm next={next} email={typeof q.email === "string" ? q.email : undefined} />
      <p className="mt-5 text-sm text-muted">
        New here? <Link href={`/signup${next !== "/" ? `?next=${encodeURIComponent(next)}` : ""}`}>Create a login</Link>
      </p>
    </>
  );
}
