import { TabBar, Tab } from "@/components/ui/Tabs";
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
      <span className="font-[var(--font-mono)] text-2xs tracking-[0.8px] text-[var(--fg-tertiary)]">
        {label}
      </span>
      <span
        className={`font-[var(--font-mono)] text-base font-semibold ${
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
      <TabBar value={scope} onValueChange={(v) => onScopeChange(v as ScopeFilter)}>
        {SCOPES.map((s) => (
          <Tab key={s.value} value={s.value}>
            {s.label}
          </Tab>
        ))}
      </TabBar>
    </div>
  );
}
