import { type ReactNode } from "react";

/** One label/value row in a detail SPEC grid. `span` makes it full-width. */
export function Field({ label, span, children }: { label: string; span?: boolean; children: ReactNode }) {
  return (
    <div className={`flex gap-2 ${span ? "col-span-2" : ""}`}>
      <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all font-mono text-foreground/90">{children}</dd>
    </div>
  );
}
