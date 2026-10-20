import { Suspense } from "react";
import { LiveRun } from "./LiveRun";

export default function GeneratePage() {
  return (
    <Suspense fallback={<p className="text-faint">Starting…</p>}>
      <LiveRun />
    </Suspense>
  );
}
