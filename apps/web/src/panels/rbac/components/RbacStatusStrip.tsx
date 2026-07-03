import type { ScopeFilter } from "../types";

interface Props {
  counts: { subjects: number; roles: number; bindings: number; dangerous: number };
  scope: ScopeFilter;
  onScopeChange: (scope: ScopeFilter) => void;
}

const SCOPES: { value: ScopeFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "namespaced", label: "Namespaced" },
  { value: "cluster", label: "Cluster" },
];

function Stat({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className="flex items-center gap-[7px]">
      <span className="font-[var(--font-mono)] text-[11px] tracking-[0.8px] text-[var(--fg-tertiary)]">
        {label}
      </span>
      <span
        className={`font-[var(--font-mono)] text-[15px] font-semibold ${
          danger ? "text-[var(--status-failed)]" : "text-[var(--fg-primary)]"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

export function RbacStatusStrip({ counts, scope, onScopeChange }: Props) {
  return (
    <div className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-[18px] py-[13px]">
      <div className="flex items-center gap-5">
        <Stat label="SUBJECTS" value={counts.subjects} />
        <Stat label="ROLES" value={counts.roles} />
        <Stat label="BINDINGS" value={counts.bindings} />
        <Stat label="DANGEROUS" value={counts.dangerous} danger />
      </div>
      <div className="flex gap-[3px] rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-[3px]">
        {SCOPES.map((s) => (
          <button
            key={s.value}
            type="button"
            onClick={() => onScopeChange(s.value)}
            aria-pressed={scope === s.value}
            className={`rounded-[var(--radius-sm)] px-[13px] py-[6px] text-[13px] transition-colors ${
              scope === s.value
                ? "bg-[#FFFFFF14] font-semibold text-[var(--fg-primary)]"
                : "text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
