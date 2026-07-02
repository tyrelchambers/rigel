import type { ReactNode } from "react";

// Shared building blocks for the "expanded row (improved)" meta strips
// (Pencil frames x2MuTZ Services / xCFK3 ConfigMaps). A MetaCard is an equal-
// width bordered card with a small uppercase mono label above its value; used
// side-by-side in a `flex gap-3` row.

/** Small uppercase mono section label (also used standalone for section headers). */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-[10.5px] uppercase tracking-[1px] text-[var(--fg-tertiary)]">
      {children}
    </span>
  );
}

/** Equal-width bordered meta card: an uppercase label over arbitrary content. */
export function MetaCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col gap-[9px] rounded-md border px-[15px] py-[13px] bg-[var(--surface-elevated)] border-[var(--border-subtle)]">
      <SectionLabel>{label}</SectionLabel>
      {children}
    </div>
  );
}
