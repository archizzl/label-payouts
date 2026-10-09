import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "labelmaker",
  description: "Run your indie label: split earnings between bands and members, pay everyone out, and ship your merch.",
  // A private app: keep it out of search engines.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col font-sans text-[14px]">{children}</body>
    </html>
  );
}
