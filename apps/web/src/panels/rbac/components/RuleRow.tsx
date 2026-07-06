import type { PolicyRule } from "../types";
import { ruleRisk } from "../risk";

function apiGroupLabel(groups: string[] | undefined): string {
  if (!groups || groups.length === 0) return "core";
  return groups.map((g) => (g === "" ? "core" : g)).join(", ");
}

function Cell({ label, items, width }: { label: string; items: string[]; width: string }) {
  return (
    <div className={`flex min-w-0 flex-col gap-[6px] ${width}`}>
      <span className="font-[var(--font-mono)] text-3xs tracking-[0.6px] text-[var(--fg-tertiary)]">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-[6px]">
        {items.map((it, i) => (
          <span
            key={i}
            className="break-words font-[var(--font-mono)] text-2xs text-[var(--fg-secondary)]"
          >
            {it}
          </span>
        ))}
      </div>
    </div>
  );
}

export function RuleRow({ rule }: { rule: PolicyRule }) {
  const dangerous = ruleRisk(rule) === "dangerous";
  return (
    <div
      className={`flex flex-wrap gap-x-4 gap-y-3 rounded-[var(--radius-md)] border bg-[var(--surface-sunken)] px-[13px] py-[11px] ${
        dangerous ? "border-[var(--status-failed)]/15" : "border-[var(--border-subtle)]"
      }`}
    >
      <Cell label="API GROUP" items={[apiGroupLabel(rule.apiGroups)]} width="w-[110px] shrink-0" />
      <Cell label="RESOURCES" items={rule.resources ?? []} width="min-w-[130px] flex-1" />
      <Cell label="VERBS" items={rule.verbs ?? []} width="min-w-[130px] flex-1" />
    </div>
  );
}
