import { type ReactNode } from "react";
import { Box, Cpu, MemoryStick, GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ActionBlock } from "@/lib/api";
import type { GitDeployment } from "@/panels/gitops/gitApi";
import { buildLinkAction, buildUnlinkAction, linkedSourceName, type WorkloadRef } from "@/panels/gitops/linkSource";
import type { Deployment } from "./types";
import type { Pod } from "../pods/types";
import { containerSummaries, strategyDescription, selectorString, relativeAge } from "./deploymentDisplay";
import {
  relativeAge as podAge,
  phaseColorClass,
  readyText as podReady,
  restartCount,
} from "../pods/podDisplay";

// ---------------------------------------------------------------------------
// Expanded detail: SPEC + PODS + Manage actions
// ---------------------------------------------------------------------------

interface DeploymentDetailProps {
  deployment: Deployment;
  pods: Pod[];
  linkTargets: { repo: string; dep: GitDeployment }[];
  onAction: (a: ActionBlock) => void;
}

export function DeploymentDetail({
  deployment,
  pods,
  linkTargets,
  onAction,
}: DeploymentDetailProps) {
  const containers = containerSummaries(deployment);
  const sortedPods = [...pods].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  const workloadRef: WorkloadRef = {
    name: deployment.metadata.name,
    namespace: deployment.metadata.namespace ?? "default",
    kind: "deployment",
  };
  const linkedSource = linkedSourceName(deployment);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        {/* SPEC block */}
        <div className="space-y-2">
          <h3 className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            Spec
          </h3>
          <dl className="space-y-1 text-xs">
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted-foreground">Strategy</dt>
              <dd className="font-mono">{strategyDescription(deployment)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted-foreground">Selector</dt>
              <dd className="font-mono">{selectorString(deployment)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted-foreground">Created</dt>
              <dd className="font-mono">{relativeAge(deployment.metadata.creationTimestamp)} ago</dd>
            </div>
          </dl>
          <div className="space-y-2 pt-1">
            {containers.map((c) => (
              <div
                key={c.name}
                className="overflow-hidden rounded-md text-xs"
                style={{ background: "var(--surface-sunken)", border: "1px solid #26272B" }}
              >
                {/* Header strip: container name + ports */}
                <div
                  className="flex items-center gap-2 px-2.5 py-1.5"
                  style={{ background: "#101014", borderBottom: "1px solid #26272B" }}
                >
                  <Box className="size-3 shrink-0 text-muted-foreground" />
                  <span className="font-mono font-medium text-primary">{c.name}</span>
                  {c.ports.length > 0 && (
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                      {c.ports.map((p) => `:${p}`).join(" ")}
                    </span>
                  )}
                </div>
                {/* Body: image + resource cells */}
                <div className="space-y-2 px-2.5 py-2">
                  <div className="font-mono text-[11px] text-muted-foreground break-all">{c.image}</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <ResourceCell
                      icon={<Cpu className="size-3 shrink-0 text-muted-foreground" />}
                      label="CPU"
                      req={c.cpuReq}
                      lim={c.cpuLim}
                    />
                    <ResourceCell
                      icon={<MemoryStick className="size-3 shrink-0 text-muted-foreground" />}
                      label="MEM"
                      req={c.memReq}
                      lim={c.memLim}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* PODS block */}
        <div className="space-y-2">
          <h3 className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            Pods ({sortedPods.length})
          </h3>
          {sortedPods.length === 0 ? (
            <p className="text-xs text-muted-foreground">No matching pods</p>
          ) : (
            <ul className="space-y-1">
              {sortedPods.map((p) => {
                const restarts = restartCount(p);
                return (
                  <li
                    key={p.metadata.uid || p.metadata.name}
                    className="group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors"
                    style={{ background: "var(--surface-sunken)", border: "1px solid #26272B" }}
                    onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#34353A")}
                    onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#26272B")}
                  >
                    <span
                      className={`inline-block size-2 shrink-0 rounded-full ${phaseColorClass(p.status?.phase)}`}
                      title={p.status?.phase ?? "Unknown"}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-foreground/90">
                      {p.metadata.name}
                    </span>
                    {restarts > 0 && (
                      <span
                        className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]"
                        style={{ background: "rgba(245,158,11,0.15)", color: "var(--status-pending)" }}
                        title={`${restarts} restart${restarts === 1 ? "" : "s"}`}
                      >
                        ↺{restarts}
                      </span>
                    )}
                    <span
                      className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                      style={{ background: "var(--surface-elevated)", border: "1px solid #26272B" }}
                    >
                      {podReady(p)}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
                      {podAge(p.metadata.creationTimestamp)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Source link — actions live in the row's right-click / kebab menu. */}
      <div
        className="flex items-center gap-2 border-t pt-3"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        {/* GitHub source link — gives the AI source context + enables fix-PRs. */}
        <div className="flex items-center gap-1.5">
          <GitBranch className="size-3" style={{ color: "var(--accent-primary)" }} />
          {linkedSource ? (
            <>
              <span className="text-xs text-muted-foreground">
                <span className="font-mono text-foreground/90">{linkedSource}</span>
              </span>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onAction(buildUnlinkAction(workloadRef))}>
                Unlink
              </Button>
            </>
          ) : linkTargets.length > 0 ? (
            <select
              defaultValue=""
              aria-label="Link to GitHub deployment"
              onChange={(e) => {
                const t = linkTargets.find((x) => x.dep.name === e.target.value);
                if (t) onAction(buildLinkAction(workloadRef, t.dep));
              }}
              className="h-7 rounded-md border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Link to GitHub…</option>
              {linkTargets.map((t) => (
                <option key={t.dep.name} value={t.dep.name}>{t.repo}/{t.dep.name}</option>
              ))}
            </select>
          ) : (
            <span className="text-xs text-muted-foreground">Link to GitHub — add a deployment in GitOps</span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A defined request/limit cell for the container card — small uppercase label
 * with an icon, then `req → lim` in mono. Reads as a compact data readout.
 */
function ResourceCell({
  icon,
  label,
  req,
  lim,
}: {
  icon: ReactNode;
  label: string;
  req: string | null | undefined;
  lim: string | null | undefined;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded px-2 py-1"
      style={{ background: "var(--surface-sunken)", border: "1px solid #26272B" }}
    >
      {icon}
      <span className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {label}
      </span>
      <span className="ml-auto font-mono text-[11px] text-foreground/90 tabular-nums">
        {req ?? "—"} <span className="text-muted-foreground">→</span> {lim ?? "—"}
      </span>
    </div>
  );
}
