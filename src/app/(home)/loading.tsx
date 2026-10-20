export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="animate-pulse space-y-6">
      <div className="h-4 w-48 rounded bg-surface-3" />
      <div className="h-12 w-3/4 rounded bg-surface-3" />
      <div className="h-24 w-full max-w-3xl rounded-xl bg-surface-2" />
      <div className="grid gap-3 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-44 rounded-xl border border-line bg-surface" />
        ))}
      </div>
    </div>
  );
}
