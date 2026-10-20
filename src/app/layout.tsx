import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "OAuth App Setup Guides for Agent Builders",
  description:
    "How hard is it to get your own OAuth app approved for Gmail, Slack, Shopify, or any app? Time, blockers, and what an agent can do for you, with evidence.",
};

const NAV = [
  { href: "/", label: "Library" },
  { href: "/verification", label: "Verification" },
  { href: "/how-it-works", label: "How it works" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col font-sans">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded focus:bg-surface-3 focus:px-3 focus:py-2">
          Skip to content
        </a>
        <header className="sticky top-0 z-40 border-b border-line bg-bg/80 backdrop-blur supports-[backdrop-filter]:bg-bg/70">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:px-5">
            <Link href="/" className="flex min-w-0 items-center gap-2.5 whitespace-nowrap font-semibold tracking-tight">
              <svg aria-hidden viewBox="0 0 24 24" className="h-6 w-6 shrink-0 rounded-md bg-accent-strong/20 p-1 text-accent ring-1 ring-accent/40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8" cy="15" r="4" />
                <path d="M10.85 12.15 19 4M18 5l2 2M15 8l2 2" />
              </svg>
              <span className="sm:hidden">OAuth Guides</span>
              <span className="hidden sm:inline">OAuth App Setup Guides</span>
              <span className="hidden rounded-full border border-line-strong px-2 py-0.5 text-[11px] font-medium text-muted md:inline">for Composio builders</span>
            </Link>
            <nav aria-label="Primary" className="flex shrink-0 gap-0.5 text-xs sm:gap-1 sm:text-sm">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href} className="whitespace-nowrap rounded-md px-2 py-1.5 text-muted transition hover:bg-surface-2 hover:text-ink sm:px-2.5">
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-5 py-10">
          {children}
        </main>
        <footer className="border-t border-line py-6 text-center text-xs text-faint">
          Take-home prototype for Composio · research aid, not legal advice
        </footer>
      </body>
    </html>
  );
}
