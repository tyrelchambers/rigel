import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ActiveForward } from "@/panels/services/portForward";
import type { SuggestedAlert } from "@helmsman/k8s";

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
  /** setEnv only: env var names to remove (kubectl `KEY-` unset syntax). */
  unsetEnv?: string[];
  container?: string;
  image?: string;
  requests?: string;
  limits?: string;
  resourceKind?: string;
  /** linkCatalogApp only: catalog app id the workload is bound to. */
  appID?: string;
  args?: string[];
  destructive?: boolean;
  /** applyManifest only — manifest YAML applied via /api/apply. */
  manifest?: string;
  /** proposeRepoFix only — git source, repo file path, PR title/body, new content. */
  source?: string;
  filePath?: string;
  title?: string;
  body?: string;
  content?: string;
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
export async function executeAction(action: ActionBlock): Promise<ActionResponse> {
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
 * Apply a manifest set via the server's stdin `kubectl apply -f -`. With
 * `dryRun`, the apiserver validates the manifest (--dry-run=server) without
 * persisting it — used by the Apply YAML panel's Validate button.
 */
export async function applyManifestYaml(yaml: string, dryRun = false): Promise<ActionResult> {
  const res = await fetch("/api/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ yaml, dryRun }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<ActionResult>;
}

export interface RepoFixResponse {
  ok: boolean;
  diff?: string; // dryRun preview
  prUrl?: string; // after a real propose
  branch?: string;
  message?: string;
}

/**
 * Preview (dryRun) or open a PR for a `proposeRepoFix` action. dryRun returns a
 * `git diff` of the proposed change; a real call branches/commits/pushes and
 * opens a pull request, returning its URL.
 */
export async function proposeRepoFix(action: ActionBlock, dryRun: boolean): Promise<RepoFixResponse> {
  const res = await fetch("/api/git/propose-fix", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: action.source,
      filePath: action.filePath,
      content: action.content,
      title: action.title ?? action.label,
      body: action.body,
      dryRun,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<RepoFixResponse>;
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
  | "setSignal"
  | "saveAlert"
  | "deleteAlert"
  | "toggleAlert";

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
  // saveAlert payload (model block, validated server-side)
  alert?: SuggestedAlert;
  // toggleAlert / deleteAlert fields
  alertId?: string;
  alertEnabled?: boolean;
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
// Metrics — GET /api/metrics/pods?namespace=<ns|*>
//           GET /api/metrics/nodes
// ---------------------------------------------------------------------------

export interface MetricItem {
  namespace?: string; // absent for nodes
  name: string;
  cpu: number; // millicores
  memory: number; // MiB
}

export interface MetricsResponse {
  available: boolean;
  items: MetricItem[];
}

/** Fetch pod metrics for a namespace (or "*" for all namespaces). */
export async function fetchPodMetrics(namespace: string): Promise<MetricsResponse> {
  const res = await fetch(`/api/metrics/pods?namespace=${encodeURIComponent(namespace)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<MetricsResponse>;
}

/** Fetch node metrics. */
export async function fetchNodeMetrics(): Promise<MetricsResponse> {
  const res = await fetch("/api/metrics/nodes");
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<MetricsResponse>;
}

/** TanStack Query hook: polls pod metrics for the given namespace every 5s. */
export function usePodMetrics(namespace: string) {
  return useQuery<MetricsResponse, Error>({
    queryKey: ["metrics", "pods", namespace],
    queryFn: () => fetchPodMetrics(namespace),
    refetchInterval: 5_000,
    staleTime: 5_000,
    retry: false,
  });
}

/** TanStack Query hook: polls node metrics every 5s. */
export function useNodeMetrics() {
  return useQuery<MetricsResponse, Error>({
    queryKey: ["metrics", "nodes"],
    queryFn: fetchNodeMetrics,
    refetchInterval: 5_000,
    staleTime: 5_000,
    retry: false,
  });
}

/** Onboarding: one-click install of the upstream metrics-server. */
export function useInstallMetricsServer() {
  const qc = useQueryClient();
  return useMutation<ActionResponse, Error, void>({
    mutationFn: async () => {
      const res = await fetch("/api/install/metrics-server", { method: "POST" });
      if (!res.ok) throw new Error((await res.text()) || "install failed");
      return (await res.json()) as ActionResponse;
    },
    // metrics take a moment to flow; nudge the metrics queries after install.
    onSuccess: () => qc.invalidateQueries({ queryKey: ["metrics"] }),
  });
}

// Per-node disk usage from the kubelet Summary API.
// GET /api/metrics/node-disk → { available, items: [{ name, ...Bytes }] }

export interface NodeDiskItem {
  name: string;
  capacityBytes: number;
  usedBytes: number;
  availableBytes: number;
}

export interface NodeDiskResponse {
  available: boolean;
  items: NodeDiskItem[];
}

export async function fetchNodeDisk(): Promise<NodeDiskResponse> {
  const res = await fetch("/api/metrics/node-disk");
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<NodeDiskResponse>;
}

/** TanStack Query hook: polls per-node disk usage every 30s (changes slowly). */
export function useNodeDisk() {
  return useQuery<NodeDiskResponse, Error>({
    queryKey: ["metrics", "node-disk"],
    queryFn: fetchNodeDisk,
    refetchInterval: 30_000,
    staleTime: 30_000,
    retry: false,
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

// ---------------------------------------------------------------------------
// Port-forward — POST /api/portforward (docs/parity/portforward.md)
//
// One endpoint, dispatched on `action`. The active list is polled (3s) via
// TanStack Query so it picks up server-side state changes (a forward becoming
// ready/failed, or a forward stopped from elsewhere). Start/stop are mutations
// that invalidate the list on settle.
// ---------------------------------------------------------------------------

export interface StartForwardParams {
  namespace: string;
  service: string;
  remotePort: number;
  localPort?: number;
}

const PORT_FORWARD_KEY = ["portforward"] as const;

async function listForwards(): Promise<ActiveForward[]> {
  const res = await fetch("/api/portforward", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "list" }),
  });
  if (!res.ok) await throwApiError(res);
  const data = (await res.json()) as { forwards?: ActiveForward[] };
  return data.forwards ?? [];
}

async function startForward(params: StartForwardParams): Promise<ActiveForward> {
  const res = await fetch("/api/portforward", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "start", ...params }),
  });
  if (!res.ok) await throwApiError(res);
  const data = (await res.json()) as { forward: ActiveForward };
  return data.forward;
}

async function stopForward(id: string): Promise<void> {
  const res = await fetch("/api/portforward", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "stop", id }),
  });
  if (!res.ok) await throwApiError(res);
}

/** Poll the active port-forwards every 3s (docs/parity/portforward.md). */
export function useForwards() {
  return useQuery({
    queryKey: PORT_FORWARD_KEY,
    queryFn: listForwards,
    refetchInterval: 3000,
  });
}

/** Start a forward, then refresh the active list. */
export function useStartForward() {
  const qc = useQueryClient();
  return useMutation<ActiveForward, Error, StartForwardParams>({
    mutationFn: startForward,
    onSettled: () => qc.invalidateQueries({ queryKey: PORT_FORWARD_KEY }),
  });
}

/** Stop a forward by id, then refresh the active list. */
export function useStopForward() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: stopForward,
    onSettled: () => qc.invalidateQueries({ queryKey: PORT_FORWARD_KEY }),
  });
}

// ---------------------------------------------------------------------------
// CNPG plugin availability — GET /api/cnpg-plugin
//
// Mirrors the Swift `CNPGPluginProbe`. The Databases panel uses this to
// enable/disable CNPG-specific actions (backup/switchover/hibernate/resume).
// ---------------------------------------------------------------------------

async function fetchCnpgPluginAvailable(): Promise<boolean> {
  const res = await fetch("/api/cnpg-plugin");
  if (!res.ok) return false;
  const data = (await res.json()) as { available?: boolean };
  return data.available === true;
}

/**
 * Whether the `kubectl cnpg` plugin is installed on the server. Probed once and
 * cached for the session (the plugin does not appear/disappear at runtime).
 */
export function useCnpgPluginAvailable() {
  return useQuery({
    queryKey: ["cnpg-plugin"] as const,
    queryFn: fetchCnpgPluginAvailable,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

/** Whether the `kubectl cert-manager` (cmctl) plugin is available on the server. */
export async function fetchCertManagerPlugin(): Promise<boolean> {
  const res = await fetch("/api/cert-manager-plugin");
  if (!res.ok) return false;
  const data = (await res.json()) as { available: boolean };
  return data.available;
}

// ---------------------------------------------------------------------------
// Chat suggestion chips — GET /api/suggestions (computed server-side from
// one-shot cluster reads). Mirrors the Swift SuggestedPromptsBuilder.
// ---------------------------------------------------------------------------

export type SuggestionKind = "pod" | "deploy" | "warn" | "node" | "investigate";

export interface SuggestedPrompt {
  id: string;
  kind: SuggestionKind;
  label: string;
  prompt: string;
}

/** Cluster-aware chat suggestions, refreshed periodically. */
export function useSuggestions() {
  return useQuery<SuggestedPrompt[], Error>({
    queryKey: ["suggestions"] as const,
    queryFn: async () => {
      const res = await fetch("/api/suggestions");
      if (!res.ok) return [];
      const data = (await res.json()) as { prompts?: SuggestedPrompt[] };
      return data.prompts ?? [];
    },
    refetchInterval: 30_000,
    staleTime: 20_000,
  });
}

// ---------------------------------------------------------------------------
// Browser auth — password login → httpOnly session cookie. GET /api/auth-status,
// POST /api/login, POST /api/logout. Cookies are same-origin so fetch sends them.
// ---------------------------------------------------------------------------

export interface AuthStatus {
  /** True when an admin password is configured (login required). */
  authRequired: boolean;
  /** True when this browser holds a valid session cookie. */
  authenticated: boolean;
}

export function useAuthStatus() {
  return useQuery<AuthStatus, Error>({
    queryKey: ["auth-status"] as const,
    queryFn: async () => {
      const res = await fetch("/api/auth-status");
      if (!res.ok) return { authRequired: false, authenticated: false };
      return (await res.json()) as AuthStatus;
    },
    staleTime: 60_000,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (password) => {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) throw new Error("Incorrect password");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth-status"] }),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation<void, Error, void>({
    mutationFn: async () => {
      await fetch("/api/logout", { method: "POST" });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth-status"] }),
  });
}

// ---------------------------------------------------------------------------
// AI copilot config — is the Claude token set? GET/POST /api/chat-config.
// ---------------------------------------------------------------------------

export interface ChatConfig {
  /** True when the copilot has a usable token (env- or in-app-supplied). */
  configured: boolean;
  /** "env" = managed by deployment env (read-only here); "file" = set in-app. */
  source: "env" | "file" | null;
  /** The k8s Secret backing the token env var, when known (for a deep link). */
  secret?: { name: string; namespace: string } | null;
}

async function fetchChatConfig(): Promise<ChatConfig> {
  const res = await fetch("/api/chat-config");
  if (!res.ok) return { configured: false, source: null };
  return (await res.json()) as ChatConfig;
}

/** Whether the AI copilot is configured. Drives the chat empty-state + Settings. */
export function useChatConfig() {
  return useQuery({
    queryKey: ["chat-config"] as const,
    queryFn: fetchChatConfig,
    staleTime: 30_000,
  });
}

/** Set (or clear, with "") the in-app Claude token, then refresh chat-config. */
export function useSetChatToken() {
  const qc = useQueryClient();
  return useMutation<ChatConfig, Error, string>({
    mutationFn: async (token) => {
      const res = await fetch("/api/chat-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) throw new Error((await res.text()) || "failed to save token");
      return (await res.json()) as ChatConfig;
    },
    onSuccess: (data) => qc.setQueryData(["chat-config"], data),
  });
}
