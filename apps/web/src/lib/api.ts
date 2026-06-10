import { useMutation, useQuery } from "@tanstack/react-query";

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
// Update detection — POST /api/updates (docs/parity/updates.md)
// ---------------------------------------------------------------------------

/** Per-image update outcome — mirrors the server `UpdateResult`. */
export interface UpdateResult {
  /** Echoed input image reference. */
  image: string;
  /** Parsed tag from the image, or null when digest-only. */
  currentTag: string | null;
  /** Version to upgrade to, or null when none / undeterminable. */
  latest: string | null;
  /** True iff a newer stable version exists. */
  updateAvailable: boolean;
  /** Which tier answered, or "unknown" when none could. */
  kind: "version" | "digest" | "none" | "unknown";
  /** For "unknown": why we couldn't decide (tooltip). */
  reason?: string;
}

export interface UpdatesResponse {
  results: UpdateResult[];
}

/** POST a batch of image refs to the update checker. */
async function fetchUpdates(images: string[]): Promise<UpdatesResponse> {
  const res = await fetch("/api/updates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ images }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<UpdatesResponse>;
}

/**
 * Update-status query for a set of installed-app images. Keyed by the sorted
 * image list so it re-runs only when the running images actually change.
 * Results are cached for the session (the client owns the TTL; the server does
 * no persistent caching).
 */
export function useUpdates(images: string[]) {
  const key = [...images].sort();
  return useQuery<UpdatesResponse, Error>({
    queryKey: ["updates", key],
    queryFn: () => fetchUpdates(key),
    enabled: images.length > 0,
    staleTime: 10 * 60_000, // 10 min — registries don't move that fast.
    gcTime: 10 * 60_000,
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

// ---------------------------------------------------------------------------
// Assistant agent control plane — POST /api/assistant (docs/parity/assistant.md)
// ---------------------------------------------------------------------------

export type AssistantAction =
  | "install"
  | "uninstall"
  | "setMode"
  | "kill"
  | "updateToken"
  | "restart"
  | "silence"
  | "unsilence"
  | "clearReport"
  | "setSignal";

export interface AssistantRequest {
  action: AssistantAction;
  namespace?: string;
  token?: string;
  image?: string;
  spendCapUsd?: number;
  workerModel?: string;
  supervisorModel?: string;
  pollIntervalMs?: number;
  maxPerResourcePerHour?: number;
  maxPerNight?: number;
  maxAttemptsPerIncident?: number;
  confirmPolls?: number;
  monitorNamespaces?: string;
  mode?: string;
  window?: string;
  enabled?: boolean;
  fingerprint?: string;
  // setSignal — Signal notifications bridge config (docs/parity/settings.md §2).
  apiUrl?: string;
  number?: string;
  recipients?: string;
  inbound?: boolean;
}

/**
 * POST an assistant control action. Returns on success; throws with the server
 * error message on failure. The token (when present) is sent in the JSON body
 * over the same authenticated channel and is never logged client-side.
 */
async function postAssistant(req: AssistantRequest): Promise<{ success: true }> {
  const res = await fetch("/api/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<{ success: true }>;
}

/** Mutation hook for every assistant control action. */
export function useAssistantAction() {
  return useMutation<{ success: true }, Error, AssistantRequest>({
    mutationFn: postAssistant,
  });
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

// ---------------------------------------------------------------------------
// Signal bridge proxy — POST /api/signal (docs/parity/settings.md §7.1)
// ---------------------------------------------------------------------------

/** Parse a server JSON error body into a thrown Error (shared with helpers). */
async function throwApiError(res: Response): Promise<never> {
  const err = await res.json().catch(() => ({ error: res.statusText }));
  throw new Error((err as { error?: string }).error ?? res.statusText);
}

/**
 * Request the link QR for the bridge. Opens a server-side port-forward and
 * returns the PNG as an object URL the caller renders in an <img>. The caller
 * is responsible for `URL.revokeObjectURL` when the QR is dismissed.
 */
export async function fetchSignalQR(namespace: string): Promise<string> {
  const res = await fetch("/api/signal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "link", namespace }),
  });
  if (!res.ok) await throwApiError(res);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/** Poll the bridge for linked accounts. Returns the registered numbers. */
export async function fetchSignalAccounts(namespace: string): Promise<string[]> {
  const res = await fetch("/api/signal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "accounts", namespace }),
  });
  if (!res.ok) await throwApiError(res);
  const data = (await res.json()) as { accounts?: string[] };
  return data.accounts ?? [];
}

/** Send a test notification through the bridge (brief port-forward). */
export async function sendSignalTest(args: {
  namespace: string;
  number: string;
  recipients: string[];
}): Promise<void> {
  const res = await fetch("/api/signal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "sendTest", ...args }),
  });
  if (!res.ok) await throwApiError(res);
}
