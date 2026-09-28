import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "labels for bandcamp",
  description: "Split Bandcamp earnings between bands and members, and pay them out.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col font-sans text-[14px]">{children}</body>
    </html>
  );
}
