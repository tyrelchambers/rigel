// Shared primitive UI components for the Assistant panel.

import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Skeleton bar — `animate-pulse` placeholder while data loads.
// ---------------------------------------------------------------------------

export function Bar({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-muted", className)} />;
}

// ---------------------------------------------------------------------------
// Layout shells
// ---------------------------------------------------------------------------

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("rounded-lg border bg-card p-3", className)}>{children}</div>;
}

export function Field({
  label,
  children,
  labelWidth = "w-40",
}: {
  label: string;
  children: React.ReactNode;
  /** Tailwind width class for the label column. Use "w-auto" to size to content. */
  labelWidth?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={cn("shrink-0 whitespace-nowrap text-sm text-muted-foreground", labelWidth)}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

export function Section({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-muted-foreground">{title}</p>
        {right}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats / status
// ---------------------------------------------------------------------------

export function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[9px] font-medium uppercase text-muted-foreground">{label}</span>
      <span className={`text-sm font-semibold ${color}`}>{value}</span>
    </div>
  );
}

export function StatusPill({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${
        enabled
          ? "bg-green-500/15 text-green-600 dark:text-green-400"
          : "bg-muted text-muted-foreground"
      }`}
    >
      {enabled ? "active" : "paused"}
    </span>
  );
}

// ---------------------------------------------------------------------------
// inputClass — shared form input styling
// ---------------------------------------------------------------------------

export const inputClass =
  "flex-1 rounded-md border bg-background px-2 py-1.5 font-mono text-sm outline-none focus:ring-2 focus:ring-ring";
