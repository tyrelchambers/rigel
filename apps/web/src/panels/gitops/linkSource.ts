// Helpers for linking a workload to a GitOps source (bidirectional UI). The link
// is the `helmsman.dev/source-repo` annotation (= source name) the AI reads for
// context + fix-PRs — stamped via the linkSourceRepo/unlinkSourceRepo actions
// (server buildCommand → kubectl annotate), run through the ConfirmSheet.
import type { ActionBlock } from "@/lib/api";
import type { GitSource } from "./gitApi";

export const SOURCE_REPO_ANNOTATION = "helmsman.dev/source-repo";

export interface WorkloadRef {
  name: string;
  namespace: string;
  /** deployment | statefulset | daemonset; defaults to deployment server-side. */
  kind?: string;
}

/** The GitOps source name a workload is linked to, or null. */
export function linkedSourceName(obj: { metadata?: { annotations?: Record<string, string> | null } }): string | null {
  return obj.metadata?.annotations?.[SOURCE_REPO_ANNOTATION] ?? null;
}

/** Action: annotate the workload with the source name + its manifest path. */
export function buildLinkAction(w: WorkloadRef, source: Pick<GitSource, "name" | "path">): ActionBlock {
  return {
    kind: "linkSourceRepo",
    name: w.name,
    namespace: w.namespace,
    resourceKind: w.kind,
    source: source.name,
    filePath: source.path,
    label: `Link ${w.name} to ${source.name}`,
  };
}

/** Action: remove the source link from the workload. */
export function buildUnlinkAction(w: WorkloadRef): ActionBlock {
  return {
    kind: "unlinkSourceRepo",
    name: w.name,
    namespace: w.namespace,
    resourceKind: w.kind,
    label: `Unlink ${w.name} from its GitOps source`,
  };
}
