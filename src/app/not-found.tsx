import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg space-y-4 py-20 text-center">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-accent">404</p>
      <h1 className="text-2xl font-semibold">That guide doesn&apos;t exist (yet)</h1>
      <p className="text-muted">It may not have been generated, or the link is wrong.</p>
      <Link href="/" className="inline-block rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-white hover:bg-violet-500">
        Back to the library
      </Link>
    </div>
  );
}
