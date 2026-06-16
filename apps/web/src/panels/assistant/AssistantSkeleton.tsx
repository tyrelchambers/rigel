// Skeleton placeholder for the Assistant panel — mirrors the ControlCenter
// shell so the first-paint morph into real content is seamless.
// No shadcn Skeleton component is installed; use a local Bar helper instead.

function Bar({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

export function AssistantSkeleton() {
  return (
    <div className="space-y-3.5" aria-hidden aria-busy>
      {/* Status strip — mirrors the Summary Card in ControlCenter */}
      <div className="rounded-lg border bg-card p-3">
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              {/* label bar ~9px tall, narrow */}
              <Bar className="h-[9px] w-14" />
              {/* value bar ~16px tall, wider */}
              <Bar className="h-4 w-20" />
            </div>
          ))}
        </div>
      </div>

      {/* Pill tab row — mirrors the 5 TabPills in ControlCenter */}
      <div className="flex flex-wrap items-center gap-1.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Bar key={i} className="h-7 w-20 rounded-full" />
        ))}
      </div>

      {/* Two card skeletons — mirrors the Overview tab cards */}
      <div className="grid grid-cols-2 gap-3">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="rounded-lg border bg-card p-3 space-y-2">
            <Bar className="h-4 w-28" />
            <Bar className="h-3 w-full" />
            <Bar className="h-3 w-2/3" />
            <Bar className="h-3 w-4/5" />
          </div>
        ))}
      </div>
    </div>
  );
}
