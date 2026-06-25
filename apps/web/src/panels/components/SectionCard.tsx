import type { ReactNode } from "react";

/**
 * A titled detail card: an uppercase section header with an optional count,
 * above a bordered, padded surface. Used to visually separate the sections of
 * a resource detail view (endpoints, labels, annotations, …). Matches the
 * RelatedResources card so the stacked sections read as one family.
 */
export function SectionCard({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {title}
        {count != null && <span className="ml-1 text-foreground/50">{count}</span>}
      </h3>
      <div className="rounded-lg p-3" style={{ background: "#141417", border: "1px solid rgba(255,255,255,0.05)" }}>
        {children}
      </div>
    </div>
  );
}
