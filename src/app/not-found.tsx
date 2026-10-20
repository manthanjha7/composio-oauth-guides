import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg space-y-4 py-20 text-center">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-accent">404</p>
      <h1 className="text-2xl font-semibold">No guide here</h1>
      <p className="text-muted">Check the link, or search the library.</p>
      <Link href="/" className="inline-block rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-white hover:bg-violet-600">
        Back to the library
      </Link>
    </div>
  );
}
