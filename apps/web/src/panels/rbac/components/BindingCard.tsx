import { Link2, ArrowRight, FileBadge, Box } from "lucide-react";
import type { Grant } from "../types";
import { RuleRow } from "./RuleRow";

function roleRefLabel(grant: Grant): string {
  const kind = grant.roleRef.kind ?? (grant.bindingKind === "RoleBinding" ? "Role" : "ClusterRole");
  return `${kind}/${grant.roleRef.name ?? "—"}`;
}

export function BindingCard({ grant }: { grant: Grant }) {
  const rules = grant.rules;
  return (
    <div className="flex flex-col gap-[13px] rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-[18px]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-[10px]">
          <Link2 className="size-[15px] text-[var(--fg-tertiary)]" />
          <span className="font-[var(--font-mono)] text-[14px] font-semibold text-[var(--fg-primary)]">
            {grant.bindingName}
          </span>
          <span className="flex items-center gap-[5px] rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-white/[0.05] px-2 py-[2px]">
            <Box className="size-[10px] text-[var(--fg-tertiary)]" />
            <span className="text-[11.5px] font-medium text-[var(--fg-secondary)]">
              {grant.scope.kind === "Namespaced" ? "Namespaced" : "Cluster"}
            </span>
            {grant.scope.kind === "Namespaced" && (
              <span className="font-[var(--font-mono)] text-[11px] text-[var(--fg-tertiary)]">
                {grant.scope.namespace}
              </span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-[9px]">
          <span className="text-[12px] text-[var(--fg-tertiary)]">grants</span>
          <ArrowRight className="size-[14px] text-[var(--fg-tertiary)]" />
          <span className="flex items-center gap-[6px] rounded-[var(--radius-sm)] border border-[var(--accent-primary)]/25 bg-[var(--accent-dim)] px-[9px] py-[3px]">
            <FileBadge className="size-[12px] text-[var(--accent-primary)]" />
            <span className="font-[var(--font-mono)] text-[12px] font-semibold text-[var(--accent-primary)]">
              {roleRefLabel(grant)}
            </span>
          </span>
        </div>
      </div>

      <div className="flex items-center gap-[7px]">
        <span className="font-[var(--font-mono)] text-[10px] tracking-[1px] text-[var(--fg-tertiary)]">
          RULES
        </span>
        <span className="font-[var(--font-mono)] text-[10px] text-[var(--fg-tertiary)]">
          {rules.length}
        </span>
        <div className="h-px flex-1 bg-[var(--border-subtle)]" />
      </div>

      {rules.length === 0 ? (
        <p className="text-[12px] text-[var(--fg-tertiary)]">
          Role not found in scope (rules unavailable).
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {rules.map((r, i) => (
            <RuleRow key={i} rule={r} />
          ))}
        </div>
      )}
    </div>
  );
}
