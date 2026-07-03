import type { PolicyRule } from "../types";
import { ruleRisk } from "../risk";

function apiGroupLabel(groups: string[] | undefined): string {
  if (!groups || groups.length === 0) return "core";
  return groups.map((g) => (g === "" ? "core" : g)).join(", ");
}

function Cell({ label, items, width }: { label: string; items: string[]; width: string }) {
  return (
    <div className={`flex flex-col gap-[6px] ${width}`}>
      <span className="font-[var(--font-mono)] text-[9.5px] tracking-[0.6px] text-[var(--fg-tertiary)]">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-[6px]">
        {items.map((it, i) => (
          <span
            key={i}
            className="font-[var(--font-mono)] text-[11px] text-[var(--fg-secondary)]"
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
      className={`flex gap-4 rounded-[var(--radius-md)] border bg-[var(--surface-sunken)] px-[13px] py-[11px] ${
        dangerous ? "border-[#EF444426]" : "border-[var(--border-subtle)]"
      }`}
    >
      <Cell label="API GROUP" items={[apiGroupLabel(rule.apiGroups)]} width="w-[120px] shrink-0" />
      <Cell label="RESOURCES" items={rule.resources ?? []} width="flex-1" />
      <Cell label="VERBS" items={rule.verbs ?? []} width="w-[300px] shrink-0" />
    </div>
  );
}
