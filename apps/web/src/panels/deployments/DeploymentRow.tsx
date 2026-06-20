import { ArrowUp, ArrowDown, GitBranch } from "lucide-react";
import { ListRow } from "@/panels/components/ListRow";
import { TagPill } from "@/panels/components/TagPill";
import { StatusBadge } from "@/panels/components/StatusBadge";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { viewYaml, editYaml } from "@/store/yamlViewer";
import type { ActionBlock } from "@/lib/api";
import type { GitDeployment } from "@/panels/gitops/gitApi";
import { buildUnlinkAction, linkedSourceName, type WorkloadRef } from "@/panels/gitops/linkSource";
import type { Deployment } from "./types";
import type { Pod } from "../pods/types";
import {
  readyText,
  isReady,
  statusColor,
  imageRepo,
  imageTag,
  firstImage,
  isRedeploying,
  rolloutProgress,
  childPods,
  totalReplicas,
} from "./deploymentDisplay";
import { DeploymentDetail } from "./DeploymentDetail";

interface DeploymentRowProps {
  d: Deployment;
  k: string;
  allPods: Pod[];
  isOpen: boolean;
  linkTargets: { repo: string; dep: GitDeployment }[];
  askClaude: (d: Deployment, topic: "Errors" | "Logs" | "Explain" | "Rollout") => void;
  restart: (d: Deployment) => void;
  openScale: (d: Deployment) => void;
  openEdit: (d: Deployment) => void;
  rollback: (d: Deployment) => void;
  togglePause: (d: Deployment) => void;
  toggleExpand: (d: Deployment) => void;
  setPendingAction: (a: ActionBlock) => void;
  setMoveTarget: (d: Deployment) => void;
}

/** One Deployment row + its expanded detail. Extracted verbatim from DeploymentsPanel. */
export function DeploymentRow({
  d,
  k,
  allPods,
  isOpen,
  linkTargets,
  askClaude,
  restart,
  openScale,
  openEdit,
  rollback,
  togglePause,
  toggleExpand,
  setPendingAction,
  setMoveTarget,
}: DeploymentRowProps) {
  const image = firstImage(d);
  const pods = childPods(d, allPods);
  const redeploying = isRedeploying(d, allPods);
  const total = totalReplicas(d);
  const updated = d.status?.updatedReplicas ?? 0;
  const paused = d.spec?.paused === true;
  const progress = rolloutProgress(d);
  const linkedSrc = linkedSourceName(d);
  const ctxRef: WorkloadRef = { name: d.metadata.name, namespace: d.metadata.namespace ?? "default", kind: "deployment" };
  const rowMenu = (
    <>
      <ContextMenuItem onClick={() => askClaude(d, "Errors")}>Ask Claude: Errors</ContextMenuItem>
      <ContextMenuItem onClick={() => askClaude(d, "Logs")}>Ask Claude: Logs</ContextMenuItem>
      <ContextMenuItem onClick={() => askClaude(d, "Explain")}>Ask Claude: Explain</ContextMenuItem>
      <ContextMenuItem onClick={() => askClaude(d, "Rollout")}>Ask Claude: Rollout</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => restart(d)}>Restart…</ContextMenuItem>
      <ContextMenuItem onClick={() => openScale(d)}>Scale…</ContextMenuItem>
      <ContextMenuItem onClick={() => openEdit(d)}>Edit config…</ContextMenuItem>
      <ContextMenuItem onClick={() => rollback(d)}>Rollback…</ContextMenuItem>
      <ContextMenuItem onClick={() => togglePause(d)}>{paused ? "Resume rollout" : "Pause rollout"}</ContextMenuItem>
      {linkedSrc && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => setPendingAction(buildUnlinkAction(ctxRef))}>Unlink from {linkedSrc}</ContextMenuItem>
        </>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => viewYaml("deployment", d.metadata.name, d.metadata.namespace)}>View YAML…</ContextMenuItem>
      <ContextMenuItem onClick={() => editYaml("deployment", d.metadata.name, d.metadata.namespace)}>Edit YAML…</ContextMenuItem>
      <ContextMenuItem onClick={() => setMoveTarget(d)}>Move to namespace…</ContextMenuItem>
      <ContextMenuItem onClick={() => toggleExpand(d)}>{isOpen ? "Collapse" : "Manage…"}</ContextMenuItem>
    </>
  );

  return (
    <ListRow
      rowKey={k}
      isOpen={isOpen}
      onToggle={() => toggleExpand(d)}
      contextMenu={rowMenu}
      progress={redeploying ? progress : undefined}
      overlay={
        redeploying ? (
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "linear-gradient(to right, rgba(16,185,129,0.18) 0%, transparent 55%)",
            }}
          />
        ) : undefined
      }
      expandedContent={
        <DeploymentDetail
          deployment={d}
          pods={pods}
          linkTargets={linkTargets}
          onAction={setPendingAction}
        />
      }
    >
      {/* Name — health-colored */}
      <button
        type="button"
        onClick={() => toggleExpand(d)}
        className={`shrink-0 font-mono text-xs font-medium leading-none hover:underline ${statusColor(d, allPods)}`}
      >
        {d.metadata.name}
      </button>

      {/* Namespace — dim tertiary chip */}
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
        {d.metadata.namespace ?? "—"}
      </span>

      {/* Image repo — dim, truncated */}
      {image && imageRepo(image) !== "—" && (
        <span
          title={image}
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 10,
            color: "var(--fg-secondary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
            flexShrink: 1,
          }}
        >
          {imageRepo(image)}
        </span>
      )}

      {/* Tag pill — shared accent purple */}
      {image && <TagPill label={imageTag(image)} title={image} />}

      {/* Linked GitOps source — at-a-glance badge (only when linked) */}
      {linkedSrc && (
        <span
          title={`Linked to GitOps source: ${linkedSrc}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            fontFamily: "ui-monospace, monospace",
            fontSize: 10,
            color: "var(--accent-primary)",
            background: "var(--surface-sunken)",
            padding: "1px 5px",
            borderRadius: 4,
            border: "1px solid #26272B",
            whiteSpace: "nowrap",
            maxWidth: 160,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          <GitBranch className="size-2.5 shrink-0" />
          {linkedSrc}
        </span>
      )}

      {/* Spacer */}
      <span className="flex-1" />

      {/* Rollout churn chips — only while live */}
      {redeploying && (
        <span className="inline-flex items-center gap-1.5 text-[10px]">
          {updated > 0 && (
            <span
              className="inline-flex items-center gap-0.5"
              style={{ color: "var(--status-running)" }}
              title={`${updated} new pod(s) up`}
            >
              <ArrowUp className="size-2.5" />
              {updated}
            </span>
          )}
          {Math.max(0, total - updated) > 0 && (
            <span
              className="inline-flex items-center gap-0.5"
              style={{ color: "var(--status-pending)" }}
              title={`${Math.max(0, total - updated)} old terminating`}
            >
              <ArrowDown className="size-2.5" />
              {Math.max(0, total - updated)}
            </span>
          )}
        </span>
      )}

      {/* Ready badge — shared StatusBadge */}
      <StatusBadge
        label={readyText(d)}
        variant={isReady(d) ? "healthy" : "error"}
      />
    </ListRow>
  );
}
