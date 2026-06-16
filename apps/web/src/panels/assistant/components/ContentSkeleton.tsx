// ContentSkeleton — 2 card-shaped placeholder blocks shown while structural
// data (deployments) or state data (configmaps) has not yet arrived.

import { Bar } from "./primitives";

export function ContentSkeleton() {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-card p-3 space-y-2">
        <Bar className="h-4 w-1/3" />
        <Bar className="h-3 w-full" />
        <Bar className="h-3 w-4/5" />
      </div>
      <div className="rounded-lg border bg-card p-3 space-y-2">
        <Bar className="h-4 w-1/4" />
        <Bar className="h-3 w-full" />
        <Bar className="h-3 w-3/5" />
      </div>
    </div>
  );
}
