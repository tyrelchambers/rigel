import { useMutation } from "@tanstack/react-query";

/**
 * ActionBlock mirrors the server-side ActionBlock interface and
 * the Swift SuggestedAction JSON contract (docs/parity/contracts.md § 1).
 */
export interface ActionBlock {
  kind: string;
  label?: string;
  name?: string;
  deployment?: string;
  pod?: string;
  node?: string;
  namespace?: string;
  replicas?: number;
  env?: Record<string, string>;
  container?: string;
  image?: string;
  requests?: string;
  limits?: string;
  resourceKind?: string;
  args?: string[];
  destructive?: boolean;
}

export interface ActionResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PurgeResult {
  purge: true;
  name: string | null;
  namespace: string;
}

export type ActionResponse = ActionResult | PurgeResult;

/** Fetch the preview command string for an action without executing it. */
export async function fetchPreviewCommand(action: ActionBlock): Promise<string[]> {
  const res = await fetch("/api/action?preview=1", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  const data = (await res.json()) as { command: string[] };
  return data.command;
}

/** Execute a chat action-block mutation via the server's guarded route. */
async function executeAction(action: ActionBlock): Promise<ActionResponse> {
  const res = await fetch("/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<ActionResponse>;
}

/**
 * TanStack Query mutation hook for executing action-block mutations.
 * The caller is responsible for showing the ConfirmSheet first.
 */
export function useAction() {
  return useMutation<ActionResponse, Error, ActionBlock>({
    mutationFn: executeAction,
  });
}

// ---------------------------------------------------------------------------
// Purge (app removal) — POST /api/purge (docs/parity/purge.md)
// ---------------------------------------------------------------------------

/** Canonical resource kinds discovered by the purge flow. */
export type PurgeResourceKind =
  | "deployment"
  | "statefulset"
  | "daemonset"
  | "service"
  | "ingress"
  | "configmap"
  | "secret"
  | "persistentvolumeclaim"
  | "job"
  | "cronjob"
  | "serviceaccount";

export interface DiscoveredResource {
  kind: PurgeResourceKind;
  name: string;
  namespace: string;
}

/** A resource the user confirmed for deletion (execute mode). */
export interface SelectedResource {
  kind: PurgeResourceKind;
  name: string;
  namespace: string;
}

export interface PurgeDiscoverResponse {
  ok: true;
  discovered: DiscoveredResource[];
  helmRelease?: string;
  blockedReason?: string;
}

export interface PurgeExecuteResultEntry {
  resource: string;
  ok: boolean;
  detail: string;
}

export interface PurgeExecuteResponse {
  ok: boolean;
  results: PurgeExecuteResultEntry[];
}

/** Dry-run discovery for the typed-name purge sheet. */
export async function discoverPurge(
  namespace: string,
  instance: string,
): Promise<PurgeDiscoverResponse> {
  const res = await fetch("/api/purge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ namespace, instance, dryRun: true }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<PurgeDiscoverResponse>;
}

export interface PurgeExecuteRequest {
  namespace: string;
  instance: string;
  helmRelease?: string | null;
  resources: SelectedResource[];
  dropDatabase?: boolean;
  databaseHint?: string | null;
}

/** Execute the purge (helm uninstall + kubectl delete per selected resource). */
export async function executePurge(
  req: PurgeExecuteRequest,
): Promise<PurgeExecuteResponse> {
  const res = await fetch("/api/purge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...req, dryRun: false }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<PurgeExecuteResponse>;
}

/** Discovery mutation hook (dry-run). */
export function usePurgeDiscovery() {
  return useMutation<PurgeDiscoverResponse, Error, { namespace: string; instance: string }>({
    mutationFn: ({ namespace, instance }) => discoverPurge(namespace, instance),
  });
}

/** Execute mutation hook. */
export function usePurgeExecute() {
  return useMutation<PurgeExecuteResponse, Error, PurgeExecuteRequest>({
    mutationFn: executePurge,
  });
}
