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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">
        <header className="border-b border-stone-200 bg-white">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-3">
            <Link href="/" className="font-semibold tracking-tight">
              OAuth App Setup Guides <span className="ml-1 rounded bg-violet-100 px-1.5 py-0.5 text-xs font-medium text-violet-700">for Composio builders</span>
            </Link>
            <nav className="flex gap-5 text-sm text-stone-600">
              <Link href="/" className="hover:text-stone-900">Library</Link>
              <Link href="/verification" className="hover:text-stone-900">Verification</Link>
              <Link href="/how-it-works" className="hover:text-stone-900">How it works</Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-5 py-8">{children}</main>
        <footer className="border-t border-stone-200 py-6 text-center text-xs text-stone-500">
          Take-home prototype for Composio · guides are research aids, not legal advice · every claim shows its evidence
        </footer>
      </body>
    </html>
  );
}
