import { useEffect, useMemo } from "react";
import { GitBranch, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ActionBlock } from "@/lib/api";
import type { GitDeployment } from "@/panels/gitops/gitApi";
import { buildLinkAction, buildUnlinkAction, linkedSourceName, type WorkloadRef } from "@/panels/gitops/linkSource";
import { RelatedResources } from "@/panels/components/RelatedResources";
import { MetaChips } from "@/panels/components/MetaChips";
import { SectionCard } from "@/panels/components/SectionCard";
import { ContainerCards } from "@/panels/components/ContainerCards";
import { Field } from "@/panels/components/Field";
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";
import type { Deployment } from "./types";
import type { Pod } from "../pods/types";
import {
  containerSummaries,
  strategyDescription,
  selectorString,
  relativeAge,
  desiredReplicas,
  readyText,
  totalRestarts,
  deploymentRevision,
  deploymentEndpoints,
} from "./deploymentDisplay";

// ---------------------------------------------------------------------------
// Expanded detail: SPEC + Related resources + Manage actions
// ---------------------------------------------------------------------------

interface DeploymentDetailProps {
  deployment: Deployment;
  linkTargets: { repo: string; dep: GitDeployment }[];
  onAction: (a: ActionBlock) => void;
}

export function DeploymentDetail({
  deployment,
  linkTargets,
  onAction,
}: DeploymentDetailProps) {
  const containers = containerSummaries(deployment);
  const ns = deployment.metadata.namespace ?? "default";
  const workloadRef: WorkloadRef = { name: deployment.metadata.name, namespace: ns, kind: "deployment" };
  const linkedSource = linkedSourceName(deployment);

  // Live data for restarts (pods) and endpoints (services + ingresses). Watches
  // are ref-counted, so subscribing here is safe alongside RelatedResources.
  const resources = useCluster((s) => s.resources);
  useEffect(() => {
    const kinds = ["pods", "services", "ingresses"];
    for (const k of kinds) subscribe(k, ns);
    return () => { for (const k of kinds) unsubscribe(k, ns); };
  }, [ns]);

  const restarts = useMemo(
    () => totalRestarts(deployment, Object.values((resources["pods"] ?? {}) as Record<string, Pod>)),
    [deployment, resources],
  );
  const revision = deploymentRevision(deployment);
  const endpoints = useMemo(
    () => deploymentEndpoints(deployment, (resources["services"] ?? {}) as Record<string, any>, (resources["ingresses"] ?? {}) as Record<string, any>),
    [deployment, resources],
  );

  return (
    <div className="space-y-4">
      {/* SPEC block */}
      <div className="space-y-2">
        <h3 className="text-[9px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          Spec
        </h3>
        <dl className="grid max-w-3xl grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
          <Field label="Namespace">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block size-1.5 rounded-full" style={{ background: "var(--status-running)" }} />
              {ns}
            </span>
          </Field>
          <Field label="Age">{relativeAge(deployment.metadata.creationTimestamp)}</Field>
          <Field label="Replicas">{desiredReplicas(deployment)}</Field>
          <Field label="Ready">{readyText(deployment)}</Field>
          <Field label="Up-to-date">{deployment.status?.updatedReplicas ?? 0}</Field>
          <Field label="Available">{deployment.status?.availableReplicas ?? 0}</Field>
          <Field label="Restarts">
            <span style={restarts > 0 ? { color: "var(--status-pending)" } : undefined}>{restarts}</span>
          </Field>
          {revision && <Field label="Revision">{revision}</Field>}
          <Field label="Strategy" span>{strategyDescription(deployment)}</Field>
          <Field label="Selector" span>{selectorString(deployment)}</Field>
          {deployment.spec?.paused && (
            <Field label="Paused" span>
              <span style={{ color: "var(--status-pending)" }}>Yes</span>
            </Field>
          )}
        </dl>
        <div className="pt-1">
          <ContainerCards containers={containers} />
        </div>
      </div>

      {/* Endpoints — ingress host(s) fronting this deployment's pods. */}
      {endpoints.length > 0 && (
        <SectionCard title="Endpoints">
          <div className="flex flex-col gap-1">
            {endpoints.map((e) => (
              <a
                key={e.host}
                href={e.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-fit items-center gap-1.5 font-mono text-xs hover:underline"
                style={{ color: "var(--accent-primary)" }}
              >
                <ExternalLink className="size-3 shrink-0" />
                {e.url}
              </a>
            ))}
          </div>
        </SectionCard>
      )}

      <MetaChips title="Labels" entries={deployment.metadata.labels} />
      <MetaChips title="Annotations" entries={deployment.metadata.annotations} />

      {/* Related resources */}
      <RelatedResources sourceKind="deployment" source={deployment} />

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
