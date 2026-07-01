import { ListRow } from "@/panels/components/ListRow";
import { WorkloadDetail } from "./WorkloadDetail";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { StatusBadge } from "@/panels/components/StatusBadge";
import { TagPill } from "@/panels/components/TagPill";
import { viewYaml } from "@/store/yamlViewer";
import { isCronJobSuspended, cronJobActiveCount, lastScheduleAgo } from "./workloadsDisplay";
import type { CronJob, AskClaudeFn } from "./types";

interface CronJobRowProps {
  c: CronJob;
  k: string;
  isOpen: boolean;
  toggleExpand: (k: string) => void;
  askClaude: AskClaudeFn;
  triggerCronJob: (c: CronJob) => void;
  suspendCronJob: (c: CronJob) => void;
  resumeCronJob: (c: CronJob) => void;
  deleteCronJob: (c: CronJob) => void;
}

/** One CronJob row. Extracted verbatim from WorkloadsPanel. */
export function CronJobRow({ c, k, isOpen, toggleExpand, askClaude, triggerCronJob, suspendCronJob, resumeCronJob, deleteCronJob }: CronJobRowProps) {
  const suspended = isCronJobSuspended(c);
  const active = cronJobActiveCount(c);
  const lastSched = lastScheduleAgo(c);

  const rowMenu = (
    <>
      <ContextMenuItem onClick={() => askClaude("cronjob", c.metadata.name, c.metadata.namespace, "Errors")}>Ask Claude: Errors</ContextMenuItem>
      <ContextMenuItem onClick={() => askClaude("cronjob", c.metadata.name, c.metadata.namespace, "Logs")}>Ask Claude: Logs</ContextMenuItem>
      <ContextMenuItem onClick={() => askClaude("cronjob", c.metadata.name, c.metadata.namespace, "Explain")}>Ask Claude: Explain</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => triggerCronJob(c)}>Trigger…</ContextMenuItem>
      {suspended ? (
        <ContextMenuItem onClick={() => resumeCronJob(c)}>Resume…</ContextMenuItem>
      ) : (
        <ContextMenuItem onClick={() => suspendCronJob(c)}>Suspend…</ContextMenuItem>
      )}
      <ContextMenuItem variant="destructive" onClick={() => deleteCronJob(c)}>Delete…</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => viewYaml("cronjob", c.metadata.name, c.metadata.namespace)}>View YAML…</ContextMenuItem>
    </>
  );

  return (
    <ListRow
      rowKey={k}
      isOpen={isOpen}
      onToggle={() => toggleExpand(k)}
      contextMenu={rowMenu}
      expandedContent={<WorkloadDetail workload={c} kind="cronjobs" />}
    >
      {/* Name */}
      <button
        type="button"
        onClick={() => toggleExpand(k)}
        className="shrink-0 font-mono text-xs font-medium leading-none hover:underline text-foreground"
      >
        {c.metadata.name}
      </button>

      {/* Namespace chip */}
      <span
        style={{
          fontFamily: "ui-monospace, monospace",
          fontSize: 10,
          color: "var(--fg-tertiary)",
          background: "var(--surface-sunken)",
          padding: "1px 5px",
          borderRadius: 4,
          border: "1px solid #26272B",
          whiteSpace: "nowrap",
        }}
      >
        {c.metadata.namespace ?? "default"}
      </span>

      {/* Schedule — purple TagPill */}
      {c.spec?.schedule && <TagPill label={c.spec.schedule} title="Schedule" />}

      {/* Spacer */}
      <span className="flex-1" />

      {/* Last schedule */}
      {lastSched && (
        <span
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 10,
            color: "var(--fg-tertiary)",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
          title="Last scheduled"
        >
          {lastSched}
        </span>
      )}

      {/* Active count */}
      {active > 0 && (
        <StatusBadge
          label={`${active} active`}
          variant="healthy"
          title={`${active} active job(s)`}
        />
      )}

      {/* Suspended badge */}
      {suspended && (
        <StatusBadge
          label="Suspended"
          variant="pending"
        />
      )}
    </ListRow>
  );
}
