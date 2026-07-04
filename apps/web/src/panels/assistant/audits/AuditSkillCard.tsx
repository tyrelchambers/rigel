import { Lock, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AuditCounts } from "@rigel/k8s";

export interface AuditSkillCardProps {
  title: string;
  description: string;
  Icon: LucideIcon;
  counts?: AuditCounts;
  onRun?: () => void;
  locked?: { reason: string };
}

export function AuditSkillCard({ title, description, Icon, counts, onRun, locked }: AuditSkillCardProps) {
  return (
    <div
      className={`rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-4 ${
        locked ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Icon className="mt-0.5 size-[18px] shrink-0 text-[var(--accent-primary)]" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[var(--fg-primary)]">{title}</p>
            <p className="mt-0.5 text-xs text-[var(--fg-tertiary)]">{description}</p>
          </div>
        </div>
        {locked ? (
          <span className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium text-[var(--fg-tertiary)] ring-1 ring-[var(--border-subtle)]">
            <Lock className="size-3" />
            Upgrade
          </span>
        ) : (
          <Button size="sm" className="shrink-0" onClick={onRun}>
            Run audit
          </Button>
        )}
      </div>

      {locked ? (
        <p className="mt-3 border-t border-[var(--border-subtle)] pt-3 text-xs text-[var(--fg-tertiary)]">
          {locked.reason}
        </p>
      ) : (
        counts && (
          <div className="mt-3 flex items-center gap-3 border-t border-[var(--border-subtle)] pt-3 font-mono text-xs">
            {counts.total === 0 ? (
              <span className="text-green-600 dark:text-green-400">No issues found</span>
            ) : (
              <>
                <span className="text-[var(--fg-secondary)]">
                  {counts.total} issue{counts.total === 1 ? "" : "s"} · {counts.workloadsAffected} workload
                  {counts.workloadsAffected === 1 ? "" : "s"}
                </span>
                {counts.critical > 0 && (
                  <span className="text-red-600 dark:text-red-400">{counts.critical} critical</span>
                )}
                {counts.warning > 0 && (
                  <span className="text-amber-600 dark:text-amber-400">{counts.warning} warning</span>
                )}
                {counts.info > 0 && <span className="text-[var(--fg-tertiary)]">{counts.info} info</span>}
              </>
            )}
          </div>
        )
      )}
    </div>
  );
}
