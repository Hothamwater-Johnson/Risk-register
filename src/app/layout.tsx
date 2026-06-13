import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Spread Scout — one view of every prediction market",
    template: "%s · Spread Scout",
  },
  description:
    "See where Kalshi and Polymarket disagree on the same event, in plain English. Price gaps, arbitrage signals, and what they actually mean.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <header className="sticky top-0 z-10 border-b border-border bg-background/90 backdrop-blur">
          <nav className="mx-auto flex max-w-2xl items-center gap-5 px-4 py-3 text-sm">
            <Link href="/" className="font-semibold tracking-tight">
              Spread<span className="text-accent">Scout</span>
            </Link>
            <Link href="/markets" className="text-muted hover:text-foreground">
              Markets
            </Link>
            <Link href="/learn" className="text-muted hover:text-foreground">
              Learn
            </Link>
            <Link href="/paper" className="text-muted hover:text-foreground">
              Paper
            </Link>
            <Link
              href="/admin/auto-trader"
              className="text-muted hover:text-foreground"
            >
              Auto-trader
            </Link>
          </nav>
        </header>
        <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">
          {children}
        </main>
        <footer className="border-t border-border py-6">
          <div className="mx-auto max-w-2xl px-4 text-xs text-muted">
            <p>
              Spread Scout shows public prices from Kalshi and Polymarket with
              estimated fees. Nothing here is financial advice; markets move
              fast and displayed prices can be stale.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
