import {
  findByDeployment,
  parseGitSources,
  GIT_SOURCES_CONFIGMAP,
  SOURCE_PATH_ANNOTATION,
  SOURCE_REPO_ANNOTATION,
} from "@rigel/k8s/src/gitSources.js";
import type { KubectlResult } from "./kubectl.js";

/**
 * Resolve a failing workload's GitOps source so autofix knows WHERE to open a fix
 * PR. Reads the workload's Deployment for the provenance annotations Rigel stamps
 * on synced resources (`rigel.dev/source-repo` → the deployment slug,
 * `rigel.dev/source-path` → the manifest dir), then looks the slug up in the
 * shared `rigel-git-sources` ConfigMap via `parseGitSources`/`findByDeployment`.
 *
 * Returns null — i.e. NOT autofix-eligible — when the Deployment is
 * missing/unreadable, carries no source-repo annotation, or names a source that
 * isn't configured. Pure except for the injected kubectl, so it is unit-testable.
 */
export interface ResolvedRepo {
  /** The matched GitOps deployment slug (== the source-repo annotation value). */
  source: string;
  repoURL: string;
  branch: string;
  /** Manifest directory within the repo the fix PR targets. */
  path: string;
}

export interface RepoResolveDeps {
  kubectl: (args: string[]) => Promise<KubectlResult>;
}

export async function resolveWorkloadRepo(
  deps: RepoResolveDeps,
  namespace: string,
  deployment: string,
  sourcesNamespace: string,
): Promise<ResolvedRepo | null> {
  const depRes = await deps.kubectl(["get", "deployment", deployment, "-n", namespace, "-o", "json"]);
  if (depRes.code !== 0) return null;

  let annotations: Record<string, string> = {};
  try {
    annotations = (JSON.parse(depRes.stdout) as { metadata?: { annotations?: Record<string, string> } })
      .metadata?.annotations ?? {};
  } catch {
    return null;
  }
  const source = (annotations[SOURCE_REPO_ANNOTATION] ?? "").trim();
  if (!source) return null; // not provenance-stamped → not tracked by GitOps
  const stampedPath = (annotations[SOURCE_PATH_ANNOTATION] ?? "").trim();

  const cmRes = await deps.kubectl(["get", "configmap", GIT_SOURCES_CONFIGMAP, "-n", sourcesNamespace, "-o", "json"]);
  if (cmRes.code !== 0) return null;
  let sourcesJSON: string | undefined;
  try {
    sourcesJSON = (JSON.parse(cmRes.stdout) as { data?: Record<string, string> }).data?.["sources.json"];
  } catch {
    return null;
  }
  const match = findByDeployment(parseGitSources(sourcesJSON), source);
  if (!match) return null; // annotated, but the source is gone from the ConfigMap

  return {
    source,
    repoURL: match.repo.repoURL,
    branch: match.repo.branch,
    path: stampedPath || match.dep.path,
  };
}
