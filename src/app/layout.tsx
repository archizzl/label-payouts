import type { Metadata } from "next";
import { Nav } from "@/components/nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "labels for bandcamp",
  description: "Split Bandcamp earnings between bands and members, and pay them out via PayPal.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col font-sans text-[14px]">
        <Nav />
        <main className="min-w-0 flex-1 px-4 py-8 md:px-8">
          <div className="mx-auto max-w-5xl">{children}</div>
        </main>
        <footer className="no-print border-t border-border px-4 py-5 text-center text-xs text-muted">
          label payouts · runs locally · your data stays on this computer
        </footer>
      </body>
    </html>
  );
}
