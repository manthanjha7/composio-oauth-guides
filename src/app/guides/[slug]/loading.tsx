export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading guide" className="animate-pulse space-y-6">
      <div className="flex gap-2">
        <div className="h-5 w-40 rounded-full bg-surface-3" />
        <div className="h-5 w-36 rounded-full bg-surface-3" />
      </div>
      <div className="h-10 w-2/3 rounded bg-surface-3" />
      <div className="h-20 w-full max-w-3xl rounded bg-surface-2" />
      <div className="h-40 w-full rounded-2xl border border-line bg-surface" />
      <div className="h-56 w-full rounded-2xl border border-line bg-surface" />
    </div>
  );
}
