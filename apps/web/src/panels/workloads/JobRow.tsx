import { Trash2 } from "lucide-react";
import { ListRow } from "@/panels/components/ListRow";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { StatusBadge } from "@/panels/components/StatusBadge";
import { ActionButtonStrip } from "@/panels/components/ActionButtonStrip";
import { viewYaml } from "@/store/yamlViewer";
import { relativeAge, jobPhase, jobCompletionsLabel, jobPhaseVariant } from "./workloadsDisplay";
import type { Job, AskClaudeFn } from "./types";

interface JobRowProps {
  j: Job;
  k: string;
  isOpen: boolean;
  toggleExpand: (k: string) => void;
  askClaude: AskClaudeFn;
  deleteJob: (j: Job) => void;
}

/** One Job row. Extracted verbatim from WorkloadsPanel. */
export function JobRow({ j, k, isOpen, toggleExpand, askClaude, deleteJob }: JobRowProps) {
  const phase = jobPhase(j);

  const rowMenu = (
    <>
      <ContextMenuItem onClick={() => askClaude("job", j.metadata.name, j.metadata.namespace, "Errors")}>Ask Claude: Errors</ContextMenuItem>
      <ContextMenuItem onClick={() => askClaude("job", j.metadata.name, j.metadata.namespace, "Logs")}>Ask Claude: Logs</ContextMenuItem>
      <ContextMenuItem onClick={() => askClaude("job", j.metadata.name, j.metadata.namespace, "Explain")}>Ask Claude: Explain</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" onClick={() => deleteJob(j)}>Delete…</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => viewYaml("job", j.metadata.name, j.metadata.namespace)}>View YAML…</ContextMenuItem>
    </>
  );

  return (
    <ListRow rowKey={k} isOpen={isOpen} onToggle={() => toggleExpand(k)} contextMenu={rowMenu}>
      {/* Name */}
      <button
        type="button"
        onClick={() => toggleExpand(k)}
        className="shrink-0 font-mono text-xs font-medium leading-none hover:underline text-foreground"
      >
        {j.metadata.name}
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
        {j.metadata.namespace ?? "default"}
      </span>

      {/* Spacer */}
      <span className="flex-1" />

      {/* Age */}
      <span
        style={{
          fontFamily: "ui-monospace, monospace",
          fontSize: 10,
          color: "var(--fg-tertiary)",
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        {relativeAge(j.metadata.creationTimestamp)}
      </span>

      {/* Completions */}
      <StatusBadge
        label={jobCompletionsLabel(j)}
        variant="neutral"
        title={`Completions: ${jobCompletionsLabel(j)}`}
      />

      {/* Phase badge */}
      <StatusBadge
        label={phase}
        variant={jobPhaseVariant(phase)}
      />

      {/* Actions */}
      <ActionButtonStrip
        onErrors={(e) => { e.stopPropagation(); askClaude("job", j.metadata.name, j.metadata.namespace, "Errors"); }}
        onLogs={(e) => { e.stopPropagation(); askClaude("job", j.metadata.name, j.metadata.namespace, "Logs"); }}
        onExplain={(e) => { e.stopPropagation(); askClaude("job", j.metadata.name, j.metadata.namespace, "Explain"); }}
        extra={[
          {
            label: "Delete",
            Icon: Trash2,
            onClick: (e) => { e.stopPropagation(); deleteJob(j); },
            destructive: true,
          },
        ]}
      />
    </ListRow>
  );
}
