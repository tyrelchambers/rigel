import { ListRow } from "@/panels/components/ListRow";
import { WorkloadDetail } from "./WorkloadDetail";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { StatusBadge } from "@/panels/components/StatusBadge";
import { viewYaml } from "@/store/yamlViewer";
import { relativeAge, readyFraction, statefulSetReady, statefulSetDesired } from "./workloadsDisplay";
import type { StatefulSet, AskClaudeFn } from "./types";

interface StatefulSetRowProps {
  s: StatefulSet;
  k: string;
  isOpen: boolean;
  toggleExpand: (k: string) => void;
  askClaude: AskClaudeFn;
  restartStatefulSet: (s: StatefulSet) => void;
  openScale: (s: StatefulSet) => void;
  deleteStatefulSet: (s: StatefulSet) => void;
}

/** One StatefulSet row. Extracted verbatim from WorkloadsPanel. */
export function StatefulSetRow({ s, k, isOpen, toggleExpand, askClaude, restartStatefulSet, openScale, deleteStatefulSet }: StatefulSetRowProps) {
  const ready = statefulSetReady(s);
  const desired = statefulSetDesired(s);
  const allReady = ready === desired;

  const rowMenu = (
    <>
      <ContextMenuItem onClick={() => askClaude("statefulset", s.metadata.name, s.metadata.namespace, "Errors")}>Ask Claude: Errors</ContextMenuItem>
      <ContextMenuItem onClick={() => askClaude("statefulset", s.metadata.name, s.metadata.namespace, "Logs")}>Ask Claude: Logs</ContextMenuItem>
      <ContextMenuItem onClick={() => askClaude("statefulset", s.metadata.name, s.metadata.namespace, "Explain")}>Ask Claude: Explain</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => restartStatefulSet(s)}>Restart…</ContextMenuItem>
      <ContextMenuItem onClick={() => openScale(s)}>Scale…</ContextMenuItem>
      <ContextMenuItem variant="destructive" onClick={() => deleteStatefulSet(s)}>Delete…</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => viewYaml("statefulset", s.metadata.name, s.metadata.namespace)}>View YAML…</ContextMenuItem>
    </>
  );

  return (
    <ListRow
      rowKey={k}
      isOpen={isOpen}
      onToggle={() => toggleExpand(k)}
      contextMenu={rowMenu}
      expandedContent={<WorkloadDetail workload={s} kind="statefulsets" />}
    >
      {/* Name */}
      <button
        type="button"
        onClick={() => toggleExpand(k)}
        className="shrink-0 font-mono text-xs font-medium leading-none hover:underline text-foreground"
        style={{ color: allReady ? undefined : "var(--status-running)" }}
      >
        {s.metadata.name}
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
        {s.metadata.namespace ?? "default"}
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
        {relativeAge(s.metadata.creationTimestamp)}
      </span>

      {/* Ready badge */}
      <StatusBadge
        label={readyFraction(ready, desired)}
        variant={allReady ? "healthy" : "pending"}
        title={`Ready: ${ready}/${desired}`}
      />
    </ListRow>
  );
}
