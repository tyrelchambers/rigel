import { ListRow } from "@/panels/components/ListRow";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { StatusBadge } from "@/panels/components/StatusBadge";
import { viewYaml } from "@/store/yamlViewer";
import { relativeAge, readyFraction, daemonSetReady, daemonSetDesired } from "./workloadsDisplay";
import type { DaemonSet, AskClaudeFn } from "./types";

interface DaemonSetRowProps {
  d: DaemonSet;
  k: string;
  isOpen: boolean;
  toggleExpand: (k: string) => void;
  askClaude: AskClaudeFn;
  restartDaemonSet: (d: DaemonSet) => void;
  deleteDaemonSet: (d: DaemonSet) => void;
}

/** One DaemonSet row. Extracted verbatim from WorkloadsPanel. */
export function DaemonSetRow({ d, k, isOpen, toggleExpand, askClaude, restartDaemonSet, deleteDaemonSet }: DaemonSetRowProps) {
  const ready = daemonSetReady(d);
  const desired = daemonSetDesired(d);
  const allReady = ready === desired;

  const rowMenu = (
    <>
      <ContextMenuItem onClick={() => askClaude("daemonset", d.metadata.name, d.metadata.namespace, "Errors")}>Ask Claude: Errors</ContextMenuItem>
      <ContextMenuItem onClick={() => askClaude("daemonset", d.metadata.name, d.metadata.namespace, "Logs")}>Ask Claude: Logs</ContextMenuItem>
      <ContextMenuItem onClick={() => askClaude("daemonset", d.metadata.name, d.metadata.namespace, "Explain")}>Ask Claude: Explain</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => restartDaemonSet(d)}>Restart…</ContextMenuItem>
      <ContextMenuItem variant="destructive" onClick={() => deleteDaemonSet(d)}>Delete…</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => viewYaml("daemonset", d.metadata.name, d.metadata.namespace)}>View YAML…</ContextMenuItem>
    </>
  );

  return (
    <ListRow rowKey={k} isOpen={isOpen} onToggle={() => toggleExpand(k)} contextMenu={rowMenu}>
      {/* Name */}
      <button
        type="button"
        onClick={() => toggleExpand(k)}
        className="shrink-0 font-mono text-xs font-medium leading-none hover:underline"
        style={{ color: allReady ? "var(--status-running)" : "var(--status-failed)" }}
      >
        {d.metadata.name}
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
        {d.metadata.namespace ?? "default"}
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
        {relativeAge(d.metadata.creationTimestamp)}
      </span>

      {/* Ready badge */}
      <StatusBadge
        label={readyFraction(ready, desired)}
        variant={allReady ? "healthy" : "error"}
        title={`Ready: ${ready}/${desired}`}
      />
    </ListRow>
  );
}
