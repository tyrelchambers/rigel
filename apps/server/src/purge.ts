// Purge (app removal) — server route handler.
//
// Two modes over `POST /api/purge`:
//   dryRun=true  → DISCOVER: run the label query (+ name-prefix fallback),
//                  filter by guardrails, detect a helm release, return the plan.
//   dryRun=false → EXECUTE: helm uninstall (if helm-managed) first, then a
//                  `kubectl delete` per selected resource, re-checking guardrails.
//
// All binaries are spawned via node:child_process argv arrays (no shell); the
// `--context` flag is prepended by `kubectl` / `buildKubectlArgs` in @rigel/k8s. Pure
// discovery/guardrail/helm logic lives in @rigel/k8s/src/purge.
//
// See docs/parity/purge.md for the normative spec.

import { kubectl, runProcess, type RunResult } from "@rigel/k8s/src/run";
import {
  type DiscoveredResource,
  type RawResource,
  type ResourceKind,
  blockedNamespaceReason,
  isProtectedNamespace,
  isSharedInfraWorkload,
  filterDiscovered,
  detectHelmRelease,
  discoveryArgs,
  fallbackDiscoveryArgs,
  deleteArgs,
  helmUninstallArgs,
  canonicalKind,
} from "@rigel/k8s/src/purge";

// ---------------------------------------------------------------------------
// Request / response shapes
// ---------------------------------------------------------------------------

/** A resource the client confirmed for deletion (execute mode). */
export interface SelectedResource {
  kind: ResourceKind;
  name: string;
  namespace: string;
}

export interface PurgeRequest {
  namespace: string;
  instance: string; // root deployment name
  dryRun?: boolean; // defaults to false
  helmRelease?: string | null; // pre-discovered hint (optional)
  /** Execute mode: the resources the user confirmed. */
  resources?: SelectedResource[];
  /** Execute mode: the optional database-drop hint the user opted into. */
  dropDatabase?: boolean;
  databaseHint?: string | null;
}

export interface DiscoverResponse {
  ok: true;
  discovered: DiscoveredResource[];
  helmRelease?: string;
  blockedReason?: string;
}

export interface ExecuteResultEntry {
  resource: string; // e.g. "helm/memos", "deployment/memos", "pvc/memos-data"
  ok: boolean;
  detail: string;
}

export interface ExecuteResponse {
  ok: boolean;
  results: ExecuteResultEntry[];
}

export type PurgeResponse = DiscoverResponse | ExecuteResponse;

/**
 * Injectable process runners (so discovery/execution are testable without
 * spawning real binaries). Defaults wire to the real kubectl/helm via node:child_process.
 *   - kubectlRun: argv WITHOUT the leading `kubectl`; `--context` is prepended.
 *   - helmRun:    full argv passed to `helm` (caller prepends `--kube-context`).
 */
export interface PurgeRunners {
  kubectlRun: (context: string | null, args: string[]) => Promise<RunResult>;
  helmRun: (args: string[]) => Promise<RunResult>;
}

const defaultRunners: PurgeRunners = {
  kubectlRun: kubectl,
  helmRun: (args) => runProcess("helm", args),
};

// ---------------------------------------------------------------------------
// Discovery (dry-run)
// ---------------------------------------------------------------------------

/** Parse the `items` array from a `kubectl get … -o json` payload. */
function parseItems(stdout: string): RawResource[] {
  try {
    const parsed = JSON.parse(stdout) as { items?: RawResource[] };
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

/**
 * Run discovery: protected-namespace guard, label query (with name-prefix
 * fallback), filtering, and helm-release detection.
 */
export async function discover(
  context: string | null,
  namespace: string,
  instance: string,
  runners: PurgeRunners = defaultRunners,
): Promise<DiscoverResponse> {
  // 1. Namespace scope check.
  const blockedReason = blockedNamespaceReason(namespace);
  if (blockedReason) {
    return { ok: true, discovered: [], blockedReason };
  }

  // 2. Label query.
  const labelRes = await runners.kubectlRun(context, discoveryArgs(instance, namespace));
  let raw = labelRes.code === 0 ? parseItems(labelRes.stdout) : [];

  // 2b. Name-prefix fallback when the instance label matched nothing.
  if (raw.length === 0) {
    const fallback = await runners.kubectlRun(context, fallbackDiscoveryArgs(namespace));
    if (fallback.code === 0) raw = parseItems(fallback.stdout);
  }

  // 3. Filter to related, non-shared-infra resources.
  const discovered = filterDiscovered(raw, instance, namespace);

  // 4. Helm release detection — scan ALL secret names in the namespace.
  const secretNames = raw
    .filter((r) => canonicalKind(r.kind) === "secret")
    .map((r) => r.metadata.name);
  const helmRelease = detectHelmRelease(secretNames, instance) ?? undefined;

  return helmRelease
    ? { ok: true, discovered, helmRelease }
    : { ok: true, discovered };
}

// ---------------------------------------------------------------------------
// Execution (execute mode)
// ---------------------------------------------------------------------------

/**
 * Run the purge: helm uninstall first (if helm-managed), then a `kubectl
 * delete` per selected resource. Guardrails are re-checked per resource.
 *
 * Execution order & failure semantics (docs/parity/purge.md):
 *   - Helm uninstall failure → STOP, do not proceed to kubectl deletes.
 *   - kubectl delete failure → continue with the rest; report each outcome.
 *   - Protected namespace / shared-infra resource → skip, log as non-ok.
 *   - dropDatabase (v1 scoping) → informational non-ok result, never executed.
 */
export async function execute(
  context: string | null,
  req: PurgeRequest,
  runners: PurgeRunners = defaultRunners,
): Promise<ExecuteResponse> {
  const results: ExecuteResultEntry[] = [];
  const namespace = req.namespace;

  // Re-check the namespace guard at execution time.
  if (isProtectedNamespace(namespace)) {
    return {
      ok: false,
      results: [
        {
          resource: `namespace/${namespace}`,
          ok: false,
          detail: "skipped — protected system namespace",
        },
      ],
    };
  }

  // 1. Helm uninstall first, if helm-managed. A failure here STOPS the sweep.
  if (req.helmRelease) {
    const helmRes = await runners.helmRun(
      // helm uses --kube-context (not --context); prepend when set.
      [...(context ? ["--kube-context", context] : []), ...helmUninstallArgs(req.helmRelease, namespace)],
    );
    const ok = helmRes.code === 0;
    results.push({
      resource: `helm/${req.helmRelease}`,
      ok,
      detail: ok ? "uninstalled" : (helmRes.stderr.trim() || `exit ${helmRes.code}`),
    });
    if (!ok) {
      // Stop immediately — do NOT proceed to kubectl deletes.
      return { ok: false, results };
    }
  }

  // 2. Sweep the selected resources.
  for (const r of req.resources ?? []) {
    // Re-check guardrails per resource at execution time.
    if (isProtectedNamespace(r.namespace)) {
      results.push({
        resource: `${r.kind}/${r.name}`,
        ok: false,
        detail: "skipped — protected system namespace",
      });
      continue;
    }
    const isWorkload =
      r.kind === "deployment" || r.kind === "statefulset" || r.kind === "daemonset";
    if (isWorkload && isSharedInfraWorkload(r.name)) {
      results.push({
        resource: `${r.kind}/${r.name}`,
        ok: false,
        detail: "skipped — protected shared-infra workload",
      });
      continue;
    }

    const delRes = await runners.kubectlRun(context, deleteArgs(r.kind, r.name, r.namespace));
    const ok = delRes.code === 0;
    results.push({
      resource: `${r.kind}/${r.name}`,
      ok,
      detail: ok ? "deleted" : (delRes.stderr.trim() || `exit ${delRes.code}`),
    });
  }

  // 3. Database drop hint (v1 scoping: informational only, never executed).
  if (req.dropDatabase && req.databaseHint) {
    results.push({
      resource: `database/${req.databaseHint}`,
      ok: false,
      detail: `DB drop requested — run manually inside the shared server (drop database "${req.databaseHint}").`,
    });
  }

  const allOk = results.every((r) => r.ok);
  return { ok: allOk, results };
}

// ---------------------------------------------------------------------------
// Route entry
// ---------------------------------------------------------------------------

/**
 * Handle `POST /api/purge`. Validates the body, then routes to discovery
 * (dryRun) or execution. Returns a JSON-serializable response object.
 */
export async function handlePurge(
  context: string | null,
  body: PurgeRequest,
  runners: PurgeRunners = defaultRunners,
): Promise<PurgeResponse> {
  if (body.dryRun) {
    return discover(context, body.namespace, body.instance, runners);
  }
  return execute(context, body, runners);
}
