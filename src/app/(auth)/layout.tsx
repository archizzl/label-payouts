import Link from "next/link";
import { Mark } from "@/components/nav";

/** Signing in, signing up, invites: a simple page without the app's navigation. */
export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main className="flex flex-1 flex-col items-center px-4 py-16">
      <Link href="/" className="mb-8 flex items-center gap-2 text-text hover:no-underline">
        <Mark />
        <span className="text-xl font-bold tracking-tight lowercase">labels for bandcamp</span>
      </Link>
      <div className="w-full max-w-sm rounded-md border border-border bg-surface p-6">{children}</div>
    </main>
  );
}
