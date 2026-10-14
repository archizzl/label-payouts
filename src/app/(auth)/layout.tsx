import Link from "next/link";
import { headers } from "next/headers";
import { FixSignIn } from "@/components/fix-sign-in";
import { Mark } from "@/components/nav";
import { hasDuplicateSession } from "@/lib/auth-cookies";

/** Signing in, signing up, invites: a simple page without the app's navigation. */
export default async function AuthLayout({ children }: LayoutProps<"/">) {
  const staleCookie = hasDuplicateSession((await headers()).get("cookie"));
  return (
    <main className="flex flex-1 flex-col items-center px-4 py-16">
      {staleCookie && <FixSignIn />}
      <Link href="/" className="mb-8 flex items-center gap-2 text-text hover:no-underline">
        <Mark />
        <span className="text-xl font-bold tracking-tight lowercase">labelmaker</span>
      </Link>
      {/* Narrow for signing in; wider for pages with more to fill in (they mark themselves .wide). */}
      <div className="w-full max-w-sm rounded-md border border-border bg-surface p-6 has-[.wide]:max-w-2xl">{children}</div>
      {/* <p className="mt-8 max-w-sm text-center text-xs text-muted">An independent tool for indie labels. Not affiliated with or endorsed by Bandcamp.</p> */}
    </main>
  );
}
