import type { Metadata } from "next";
import { Instrument_Sans } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

/** The labelmaker wordmark: TeX Gyre Adventor, a free Avant Garde Gothic revival (see fonts/README.md). */
const brand = localFont({
  src: [
    { path: "./fonts/texgyreadventor-regular.otf", weight: "400", style: "normal" },
    { path: "./fonts/texgyreadventor-bold.otf", weight: "700", style: "normal" },
  ],
  variable: "--font-adventor",
  display: "swap",
});

/** Everything else. */
const text = Instrument_Sans({ subsets: ["latin"], variable: "--font-text", display: "swap" });

export const metadata: Metadata = {
  // Each page names itself: "labelmaker - orders".
  title: { template: "labelmaker - %s", default: "labelmaker" },
  description: "Run your indie label: split earnings between bands and members, pay everyone out, and ship your merch.",
  // A private app: keep it out of search engines.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`h-full antialiased ${brand.variable} ${text.variable}`}>
      <body className="flex min-h-full flex-col font-sans text-[14px]">{children}</body>
    </html>
  );
}
