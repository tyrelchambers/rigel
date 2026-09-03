import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ActiveForward } from "@/panels/services/portForward";
import type { SuggestedAlert, DigestInput, ApplySource, RecentBatch, ChannelId } from "@rigel/k8s";
import type { ManifestEdit } from "@rigel/k8s/src/manifestEdit";
import type { CheckResult, CloudProvider, CloudCluster } from "@rigel/cloud-connect/src/index";
import type { Subject } from "@/panels/rbac/types";
import type { CanICheck, CanIResult } from "@/panels/rbac/canI";
import { useCluster } from "@/store/cluster";
import { rigel } from "@/lib/desktop";

export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const ctx = useCluster.getState().activeContext;
  if (ctx) headers.set("X-Rigel-Context", ctx);
  const secret = rigel?.sessionSecret;
  if (secret) headers.set("x-rigel-session", secret);
  return fetch(input, { ...init, headers });
}

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
  /** applyManifest only — which Rigel surface triggered the apply (ledger recording). */
  applySource?: ApplySource;
  /** proposeRepoFix only — git source, repo file path, PR title/body, new content. */
  source?: string;
  filePath?: string;
  title?: string;
  body?: string;
  content?: string;
  /** proposeRepoFix only — the change as an intent, which the server turns into
   *  the edited manifest. The alternative to filePath + content. */
  edit?: ManifestEdit;
  /** setImagePullSecrets only — desired full list of imagePullSecret names. */
  imagePullSecrets?: string[];
  /** setEnvRef only — env vars sourced from a Secret/ConfigMap key. */
  envRefs?: Array<{ name: string; source: "secret" | "configMap"; resourceName: string; key: string }>;
}

export interface ActionResult {
  code: number;
  stdout: string;
  stderr: string;
  /** applyManifest only — set when the apply created resources and recorded a batch. */
  batchId?: string;
}

export interface PurgeResult {
  purge: true;
  name: string | null;
  namespace: string;
}

export type ActionResponse = ActionResult | PurgeResult;

/** Fetch the preview command string for an action without executing it. */
export async function fetchPreviewCommand(action: ActionBlock): Promise<string[]> {
  const res = await apiFetch("/api/action?preview=1", {
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
  const res = await apiFetch("/api/action", {
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
export async function applyManifestYaml(
  yaml: string,
  dryRun = false,
  source?: ApplySource,
): Promise<ActionResult> {
  const res = await apiFetch("/api/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ yaml, dryRun, ...(source ? { source } : {}) }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<ActionResult>;
}

/**
 * Delete a manifest set via the server's stdin `kubectl delete -f -
 * --ignore-not-found` (the uninstall counterpart of applyManifestYaml).
 */
export async function deleteManifestYaml(yaml: string): Promise<ActionResult> {
  const res = await apiFetch("/api/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ yaml }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<ActionResult>;
}

/**
 * Fetch a resource's YAML via `GET /api/resource` (server runs the guarded
 * `kubectl get -o yaml`). With `clean`, the server strips status + managedFields
 * so the manifest is ready to re-apply. Shared by the YAML viewer and the
 * ConfigMaps Download YAML / Copy actions.
 */
export async function fetchResourceYaml(
  kind: string,
  name: string,
  namespace?: string,
  clean?: boolean,
): Promise<string> {
  const params = new URLSearchParams({ kind, name });
  if (namespace) params.set("namespace", namespace);
  if (clean) params.set("clean", "1");
  const res = await apiFetch(`/api/resource?${params.toString()}`);
  const data = (await res.json().catch(() => ({}))) as {
    code?: number;
    yaml?: string;
    stderr?: string;
    error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  if (data.code !== 0) throw new Error(data.stderr || "kubectl get failed");
  return data.yaml ?? "";
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
  const res = await apiFetch("/api/git/propose-fix", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: action.source,
      filePath: action.filePath,
      content: action.content,
      name: action.name,
      namespace: action.namespace,
      resourceKind: action.resourceKind,
      edit: action.edit,
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

/** An installed image to check: its spec tag plus the digest the pod actually
 *  pulled (from `imageID`), so the moving-tag tier can spot a stale pod whose
 *  `:latest`/`:stable` tag has since advanced. */
export interface UpdateImageInput {
  image: string;
  runningDigest?: string | null;
}

/** POST a batch of images (tag + running digest) to the update checker. */
async function fetchUpdates(images: UpdateImageInput[]): Promise<UpdatesResponse> {
  const res = await apiFetch("/api/updates", {
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
 * (tag + running digest) list so it re-runs when either the spec tag OR the
 * pulled digest changes. Results are cached for the session (the client owns
 * the TTL; the server does no persistent caching).
 */
export interface ImageUpdate {
  result: UpdateResult | undefined;
  isPending: boolean;
}

/**
 * One independent update check per image, keyed by that image alone — so
 * updating a single app re-checks only that app and never refetches or blocks
 * the others. Images in `skip` are treated as current: their query is disabled
 * (no network check). Returns a Map keyed by image string.
 */
export function useUpdatesByImage(
  images: UpdateImageInput[],
  skip?: ReadonlySet<string>,
): Map<string, ImageUpdate> {
  const results = useQueries({
    queries: images.map((i) => {
      const runningDigest = i.runningDigest ?? null;
      return {
        queryKey: ["updates", i.image, runningDigest],
        queryFn: () => fetchUpdates([{ image: i.image, runningDigest }]),
        enabled: !skip?.has(i.image),
        staleTime: 10 * 60_000, // 10 min — registries don't move that fast.
        gcTime: 10 * 60_000,
      };
    }),
  });
  const byImage = new Map<string, ImageUpdate>();
  images.forEach((i, idx) => {
    const q = results[idx];
    byImage.set(i.image, {
      result: q?.data?.results?.[0],
      isPending: (q?.isPending ?? false) && q?.fetchStatus !== "idle",
    });
  });
  return byImage;
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
  const res = await apiFetch("/api/purge", {
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
  const res = await apiFetch("/api/purge", {
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
  | "setModels"
  | "setCredentials"
  | "setLimits"
  | "setAutofix"
  | "restart"
  | "silence"
  | "unsilence"
  | "clearReport"
  | "clearActivity"
  | "setSignal"
  | "setMatrix"
  | "setChannel"
  | "saveAlert"
  | "deleteAlert"
  | "toggleAlert"
  | "saveDigest"
  | "deleteDigest"
  | "toggleDigest"
  | "sendDigestNow"
  | "credentialStatus"
  | "listCredentialSecrets"
  | "setCredentialSource"
  | "clearCredentialSource"
  | "reconcileCredentialAnnotations"
  | "getRbac"
  | "setRbac"
  | "installedContexts";

export interface AssistantRoleSelection {
  provider: string;
  model: string;
  effort?: string;
}

/** Provider credentials → the rigel-assistant-credentials Secret keys. */
export interface AssistantCredentials {
  claudeToken?: string;
  anthropicApiKey?: string;
  codexApiKey?: string;
  codexAuthContent?: string;
  geminiApiKey?: string;
  opencodeApiKey?: string;
  opencodeAuthContent?: string;
  agentToken?: string;
}

/** Per-credential readiness + backing Secret name from the server's
 *  credentialStatus read. Names only — the value never leaves the cluster. */
export interface CredentialSourceStatus {
  ready: boolean;
  secretName: string;
}

/** credentialStatus response: per-credential `{ ready, secretName }` keyed by the
 *  AssistantCredentials credential id (only present ids are included). `conflicts`
 *  are ids claimed by more than one credential-store Secret (alphabetically-first
 *  wins; surfaced so the UI can warn). `needsReconcile` is true when a legacy
 *  install has fallback-resolved credentials not yet stamped with annotations
 *  (drives the Repair button). Both names/ids only — never values. */
export interface CredentialStatusResponse {
  credentials: Partial<Record<keyof AssistantCredentials, CredentialSourceStatus>>;
  conflicts?: (keyof AssistantCredentials)[];
  needsReconcile?: boolean;
}

/** A candidate Secret for the BYO source picker: name, type, and data KEY NAMES
 *  only (never values). */
export interface CredentialSecret {
  name: string;
  type: string;
  keys: string[];
}

export interface AssistantLimits {
  pollIntervalMs?: number;
  maxPerResourcePerHour?: number;
  maxPerNight?: number;
  maxAttemptsPerIncident?: number;
  confirmPolls?: number;
  namespaces?: string[];
}

/** Autofix (agent-opened fix PR) scope: the specific projects opted in. A project
 *  id is "<namespace>/<deployment>". Empty = nothing opted in. Per-project ONLY —
 *  a namespace holds deployments mapping to many repos, so a whole-namespace opt-in
 *  is never one-to-one (mirrors the agent's AutofixScope). */
export interface AutofixScopeInput {
  projects?: string[];
}

export interface AssistantRequest {
  action: AssistantAction;
  namespace?: string;
  token?: string;
  image?: string;
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
  /** Notify webhook (Slack/Discord/ntfy) URL, saved alongside the autonomy mode.
   *  Written only when present, so a mode change never clears it and vice versa. */
  webhook?: string;
  enabled?: boolean;
  fingerprint?: string;
  // setSignal — Signal notifications bridge config (docs/parity/settings.md §2).
  apiUrl?: string;
  number?: string;
  recipients?: string;
  // setMatrix — Matrix channel config (token → Secret; rest → assistant-config).
  matrixHomeserverUrl?: string;
  matrixUserId?: string;
  matrixAccessToken?: string;
  matrixRoomId?: string;
  matrixAllowedSenders?: string;
  // setChannel — generic connect/disconnect + notify-toggle writer for the
  // url-backed channels (Discord/Slack). channelData is filtered server-side to
  // the target channel's configKeys (packages/k8s/src/channels.ts); channelNotify
  // toggles that channel's membership in the notifyChannels allowlist. Also used
  // (channelNotify only, no channelData) to toggle the Signal/Matrix notify flag.
  channel?: ChannelId;
  channelData?: Record<string, string>;
  channelNotify?: boolean;
  // saveAlert payload (model block, validated server-side)
  alert?: SuggestedAlert;
  // toggleAlert / deleteAlert fields
  alertId?: string;
  alertEnabled?: boolean;
  // scheduled digests (saveDigest/deleteDigest/toggleDigest/sendDigestNow)
  digest?: DigestInput;
  digestId?: string;
  digestEnabled?: boolean;
  digestMode?: "send" | "preview";
  // Multi-provider control plane (Plan 2). provider is a plain string (the four
  // agent ids: claude | codex | gemini | opencode); effort is Claude-family only.
  worker?: AssistantRoleSelection;
  supervisor?: AssistantRoleSelection;
  credentials?: AssistantCredentials;
  limits?: AssistantLimits;
  // setAutofix — agent-opened fix PR control surface. Written to assistant-config
  // with the EXACT keys the agent reads (autofixEnabled / autofixMaxPerDay /
  // autofixScope). Only provided fields are written.
  autofixEnabled?: boolean;
  autofixMaxPerDay?: number;
  autofixScope?: AutofixScopeInput;
  // BYO credential source (setCredentialSource / clearCredentialSource). Only
  // ids + Secret/data-key NAMES — never a secret value.
  credentialId?: keyof AssistantCredentials;
  secretName?: string;
  dataKey?: string;
  // getRbac/setRbac — the Permissions tab's staged RbacPolicy, serialized (see
  // @rigel/k8s serializePolicy), and which context(s) setRbac applies the
  // rendered ClusterRole to.
  policy?: string;
  contexts?: string[];
}

/** Shape returned by the assistant route on success (stdout is present for read
 *  actions like credentialStatus; mutations return an empty stdout). */
export interface AssistantRunResult {
  success: true;
  stdout: string;
  stderr: string;
}

/**
 * POST an assistant control action. Returns on success; throws with the server
 * error message on failure. The token (when present) is sent in the JSON body
 * over the same authenticated channel and is never logged client-side.
 */
export async function postAssistant(req: AssistantRequest): Promise<AssistantRunResult> {
  const res = await apiFetch("/api/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<AssistantRunResult>;
}

/** Mutation hook for every assistant control action. */
export function useAssistantAction() {
  return useMutation<AssistantRunResult, Error, AssistantRequest>({
    mutationFn: postAssistant,
  });
}

/** Set the agent's autofix opt-in / daily cap / scope (POST /api/assistant
 *  `setAutofix`). Only the provided fields are written, so toggling the opt-in
 *  never clobbers the scope and vice versa. */
export interface SetAutofixInput {
  namespace?: string;
  enabled?: boolean;
  maxPerDay?: number;
  scope?: AutofixScopeInput;
}

export async function setAutofix(input: SetAutofixInput): Promise<AssistantRunResult> {
  return postAssistant({
    action: "setAutofix",
    namespace: input.namespace,
    autofixEnabled: input.enabled,
    autofixMaxPerDay: input.maxPerDay,
    autofixScope: input.scope,
  });
}

/** Mutation hook for the autofix control surface. */
export function useSetAutofix() {
  return useMutation<AssistantRunResult, Error, SetAutofixInput>({
    mutationFn: setAutofix,
  });
}

/**
 * Candidate Secrets in the agent's namespace for the BYO credential-source
 * picker — names + data key NAMES only (values never reach the client). Enabled
 * once a namespace is known; refetched lazily (Secrets don't churn fast).
 */
export function useCredentialSecrets(namespace: string | undefined) {
  const activeContext = useCluster((s) => s.activeContext);
  return useQuery<CredentialSecret[], Error>({
    queryKey: [activeContext, "assistant-credentialSecrets", namespace] as const,
    queryFn: async () => {
      const res = await postAssistant({ action: "listCredentialSecrets", namespace });
      const parsed = JSON.parse(res.stdout || "{}") as { secrets?: CredentialSecret[] };
      return parsed.secrets ?? [];
    },
    enabled: !!namespace,
    staleTime: 30_000,
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
// Recent deploys + undo — GET /api/deployments/recent, POST /api/deployments/undo
// ---------------------------------------------------------------------------

export interface RecentDeploysResponse {
  batches: RecentBatch[];
}

export interface UndoDeployResultEntry {
  resource: string;
  ok: boolean;
  detail: string;
}

export interface UndoDeployResponse {
  ok: boolean;
  results: UndoDeployResultEntry[];
}

/** Batches Rigel applied within the recent window (Overview "Recent" card). */
export async function fetchRecentDeploys(): Promise<RecentDeploysResponse> {
  const res = await apiFetch("/api/deployments/recent");
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<RecentDeploysResponse>;
}

/** Undo a batch: delete every resource it created. `namespace` = the ledger's own namespace. */
export async function undoDeploy(batchId: string, namespace: string): Promise<UndoDeployResponse> {
  const res = await apiFetch("/api/deployments/undo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ batchId, namespace }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<UndoDeployResponse>;
}

/** Query hook for the Overview "Recent" card. */
export function useRecentDeploys() {
  const activeContext = useCluster((s) => s.activeContext);
  return useQuery<RecentDeploysResponse, Error>({
    queryKey: [activeContext, "recent-deploys"],
    queryFn: fetchRecentDeploys,
    staleTime: 30_000,
  });
}

/** Undo mutation; invalidates the recent-deploys query on success. */
export function useUndoDeploy() {
  const qc = useQueryClient();
  const activeContext = useCluster((s) => s.activeContext);
  return useMutation<UndoDeployResponse, Error, { batchId: string; namespace: string }>({
    mutationFn: ({ batchId, namespace }) => undoDeploy(batchId, namespace),
    onSuccess: () => qc.invalidateQueries({ queryKey: [activeContext, "recent-deploys"] }),
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
  const res = await apiFetch(`/api/metrics/pods?namespace=${encodeURIComponent(namespace)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<MetricsResponse>;
}

/** Fetch node metrics. */
export async function fetchNodeMetrics(): Promise<MetricsResponse> {
  const res = await apiFetch("/api/metrics/nodes");
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<MetricsResponse>;
}

/** TanStack Query hook: polls pod metrics for the given namespace every 5s. */
export function usePodMetrics(namespace: string) {
  const activeContext = useCluster((s) => s.activeContext);
  return useQuery<MetricsResponse, Error>({
    queryKey: [activeContext, "metrics", "pods", namespace],
    queryFn: () => fetchPodMetrics(namespace),
    refetchInterval: 5_000,
    staleTime: 5_000,
    retry: false,
  });
}

/** TanStack Query hook: polls node metrics every 5s. */
export function useNodeMetrics() {
  const activeContext = useCluster((s) => s.activeContext);
  return useQuery<MetricsResponse, Error>({
    queryKey: [activeContext, "metrics", "nodes"],
    queryFn: fetchNodeMetrics,
    refetchInterval: 5_000,
    staleTime: 5_000,
    retry: false,
  });
}

/** Onboarding: one-click install of the upstream metrics-server. */
export function useInstallMetricsServer() {
  const qc = useQueryClient();
  const activeContext = useCluster((s) => s.activeContext);
  return useMutation<ActionResponse, Error, { kubeletInsecureTls?: boolean } | void>({
    mutationFn: async (vars) => {
      const res = await apiFetch("/api/install/metrics-server", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars ?? {}),
      });
      if (!res.ok) throw new Error((await res.text()) || "install failed");
      return (await res.json()) as ActionResponse;
    },
    // metrics take a moment to flow; nudge the metrics queries after install.
    onSuccess: () => qc.invalidateQueries({ queryKey: [activeContext, "metrics"] }),
  });
}

/** Uninstall the upstream metrics-server (POST /api/uninstall/metrics-server). */
export function useUninstallMetricsServer() {
  const qc = useQueryClient();
  const activeContext = useCluster((s) => s.activeContext);
  return useMutation<ActionResponse, Error, void>({
    mutationFn: async () => {
      const res = await apiFetch("/api/uninstall/metrics-server", { method: "POST" });
      if (!res.ok) throw new Error((await res.text()) || "uninstall failed");
      return (await res.json()) as ActionResponse;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [activeContext, "metrics"] }),
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
  const res = await apiFetch("/api/metrics/node-disk");
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<NodeDiskResponse>;
}

/** TanStack Query hook: polls per-node disk usage every 30s (changes slowly). */
export function useNodeDisk() {
  const activeContext = useCluster((s) => s.activeContext);
  return useQuery<NodeDiskResponse, Error>({
    queryKey: [activeContext, "metrics", "node-disk"],
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
  const res = await apiFetch("/api/signal", {
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
  const res = await apiFetch("/api/signal", {
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
  const res = await apiFetch("/api/signal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "sendTest", ...args }),
  });
  if (!res.ok) await throwApiError(res);
}

// ---------------------------------------------------------------------------
// Matrix connect proxy — POST /api/matrix
// ---------------------------------------------------------------------------

export interface MatrixLoginResult {
  accessToken: string;
  userId: string;
}

/** Log the bot in (username + password) and return a token + the resolved id. */
export async function matrixLogin(homeserver: string, user: string, password: string): Promise<MatrixLoginResult> {
  const res = await apiFetch("/api/matrix", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "login", homeserver, user, password }),
  });
  if (!res.ok) await throwApiError(res);
  return (await res.json()) as MatrixLoginResult;
}

/** Validate a pasted access token against the homeserver (whoami); returns the id. */
export async function matrixValidate(homeserver: string, accessToken: string): Promise<{ userId: string }> {
  const res = await apiFetch("/api/matrix", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "validate", homeserver, accessToken }),
  });
  if (!res.ok) await throwApiError(res);
  return (await res.json()) as { userId: string };
}

/** Provision an unencrypted room and invite the allowed senders; returns its id. */
export async function matrixCreateRoom(
  homeserver: string,
  accessToken: string,
  roomName: string,
  invite: string[],
): Promise<{ roomId: string }> {
  const res = await apiFetch("/api/matrix", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "createRoom", homeserver, accessToken, roomName, invite }),
  });
  if (!res.ok) await throwApiError(res);
  return (await res.json()) as { roomId: string };
}

export interface MatrixPollResult {
  userMessaged: boolean;
  botReplied: boolean;
}

/** Poll the bot room for user messages and bot replies; returns the handshake state. */
export async function matrixPoll(args: {
  homeserver: string;
  accessToken: string;
  roomId: string;
  botUserId: string;
  allowedSenders: string[];
}): Promise<MatrixPollResult> {
  const res = await apiFetch("/api/matrix", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "poll", ...args }),
  });
  if (!res.ok) await throwApiError(res);
  return (await res.json()) as MatrixPollResult;
}

/** Send a test message from Rigel into the bot room. */
export async function matrixSendTest(args: {
  homeserver: string;
  accessToken: string;
  roomId: string;
}): Promise<{ ok: true }> {
  const res = await apiFetch("/api/matrix", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "sendTest", ...args }),
  });
  if (!res.ok) await throwApiError(res);
  return (await res.json()) as { ok: true };
}

// ---------------------------------------------------------------------------
// Channel test-send — POST /api/channels (Discord/Slack webhook proxy)
// ---------------------------------------------------------------------------

/** Send a test message through a url-backed channel's webhook (Discord/Slack).
 *  Filter-driven — `channel` selects the payload shape server-side; no per-channel
 *  function. */
export async function sendChannelTest(args: { channel: ChannelId; url: string }): Promise<void> {
  const res = await apiFetch("/api/channels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "sendTest", ...args }),
  });
  if (!res.ok) await throwApiError(res);
}

/** Mutation hook for the channel "Send test" button. */
export function useChannelTest() {
  return useMutation<void, Error, { channel: ChannelId; url: string }>({
    mutationFn: sendChannelTest,
  });
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

function portForwardKey(activeContext: string | null) {
  return [activeContext, "portforward"] as const;
}

async function listForwards(): Promise<ActiveForward[]> {
  const res = await apiFetch("/api/portforward", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "list" }),
  });
  if (!res.ok) await throwApiError(res);
  const data = (await res.json()) as { forwards?: ActiveForward[] };
  return data.forwards ?? [];
}

async function startForward(params: StartForwardParams): Promise<ActiveForward> {
  const res = await apiFetch("/api/portforward", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "start", ...params }),
  });
  if (!res.ok) await throwApiError(res);
  const data = (await res.json()) as { forward: ActiveForward };
  return data.forward;
}

async function stopForward(id: string): Promise<void> {
  const res = await apiFetch("/api/portforward", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "stop", id }),
  });
  if (!res.ok) await throwApiError(res);
}

/** Poll the active port-forwards every 3s (docs/parity/portforward.md). */
export function useForwards() {
  const activeContext = useCluster((s) => s.activeContext);
  return useQuery({
    queryKey: portForwardKey(activeContext),
    queryFn: listForwards,
    refetchInterval: 3000,
  });
}

/** Start a forward, then refresh the active list. */
export function useStartForward() {
  const qc = useQueryClient();
  const activeContext = useCluster((s) => s.activeContext);
  return useMutation<ActiveForward, Error, StartForwardParams>({
    mutationFn: startForward,
    onSettled: () => qc.invalidateQueries({ queryKey: portForwardKey(activeContext) }),
  });
}

/** Stop a forward by id, then refresh the active list. */
export function useStopForward() {
  const qc = useQueryClient();
  const activeContext = useCluster((s) => s.activeContext);
  return useMutation<void, Error, string>({
    mutationFn: stopForward,
    onSettled: () => qc.invalidateQueries({ queryKey: portForwardKey(activeContext) }),
  });
}

// ---------------------------------------------------------------------------
// CNPG plugin availability — GET /api/cnpg-plugin
//
// Mirrors the Swift `CNPGPluginProbe`. The Databases panel uses this to
// enable/disable CNPG-specific actions (backup/switchover/hibernate/resume).
// ---------------------------------------------------------------------------

async function fetchCnpgPluginAvailable(): Promise<boolean> {
  const res = await apiFetch("/api/cnpg-plugin");
  if (!res.ok) return false;
  const data = (await res.json()) as { available?: boolean };
  return data.available === true;
}

/**
 * Whether the `kubectl cnpg` plugin is installed on the server. Probed once and
 * cached for the session (the plugin does not appear/disappear at runtime).
 */
export function useCnpgPluginAvailable() {
  const activeContext = useCluster((s) => s.activeContext);
  return useQuery({
    queryKey: [activeContext, "cnpg-plugin"] as const,
    queryFn: fetchCnpgPluginAvailable,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

/** Whether the `kubectl cert-manager` (cmctl) plugin is available on the server. */
export async function fetchCertManagerPlugin(): Promise<boolean> {
  const res = await apiFetch("/api/cert-manager-plugin");
  if (!res.ok) return false;
  const data = (await res.json()) as { available: boolean };
  return data.available;
}

// ---------------------------------------------------------------------------
// API resources — GET /api/api-resources. Drives the RBAC rule editor's
// API-groups/resources combobox suggestions ("groups" includes the literal
// "core").
// ---------------------------------------------------------------------------

export interface ApiResourcesResponse {
  resources: string[];
  groups: string[];
  verbsByResource: Record<string, string[]>;
}

async function fetchApiResources(): Promise<ApiResourcesResponse> {
  const res = await apiFetch("/api/api-resources");
  if (!res.ok) return { resources: [], groups: [], verbsByResource: {} };
  const data = (await res.json()) as Partial<ApiResourcesResponse>;
  return {
    resources: data.resources ?? [],
    groups: data.groups ?? [],
    verbsByResource: data.verbsByResource ?? {},
  };
}

/** Cluster API resources/groups, cached per-context (rarely changes). */
export function useApiResources() {
  const activeContext = useCluster((s) => s.activeContext);
  return useQuery<ApiResourcesResponse, Error>({
    queryKey: [activeContext, "api-resources"] as const,
    queryFn: fetchApiResources,
    staleTime: 5 * 60_000,
  });
}

export interface CanIResponse {
  results: Array<{ subject: Subject; checks: CanIResult[] }>;
  note?: string;
}

/** Impersonated `kubectl auth can-i` for the RBAC access test (read-only). */
export async function postCanICheck(subjects: Subject[], checks: CanICheck[]): Promise<CanIResponse> {
  const res = await apiFetch("/api/rbac/can-i", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subjects, checks }),
  });
  if (!res.ok) throw new Error(`Access test failed: ${res.status}`);
  return (await res.json()) as CanIResponse;
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
  const activeContext = useCluster((s) => s.activeContext);
  return useQuery<SuggestedPrompt[], Error>({
    queryKey: [activeContext, "suggestions"] as const,
    queryFn: async () => {
      const res = await apiFetch("/api/suggestions");
      if (!res.ok) return [];
      const data = (await res.json()) as { prompts?: SuggestedPrompt[] };
      return data.prompts ?? [];
    },
    refetchInterval: 30_000,
    staleTime: 20_000,
  });
}

// ---------------------------------------------------------------------------
// AI copilot config — is the Claude token set? GET/POST /api/chat-config.
// ---------------------------------------------------------------------------

/**
 * Where a config lives and whether that cluster could be read. "unavailable"
 * means nothing was read, which is NOT the same as an empty config: one is a
 * disconnected cluster, the other is a connected one nobody has configured yet.
 */
export interface ClusterConfigStatus {
  context: string | null;
  namespace: string;
  secret: string;
  state: "ok" | "unavailable";
  message?: string;
}

export interface ChatConfig {
  /** True when the copilot has a usable token (env- or in-app-supplied). */
  configured: boolean;
  /** "env" = managed by deployment env (read-only here); "cluster" = set in-app. */
  source: "env" | "cluster" | null;
  /** The k8s Secret backing the token env var, when known (for a deep link). */
  secret?: { name: string; namespace: string } | null;
  cluster?: ClusterConfigStatus;
}

async function fetchChatConfig(): Promise<ChatConfig> {
  const res = await apiFetch("/api/chat-config");
  if (!res.ok) return { configured: false, source: null };
  return (await res.json()) as ChatConfig;
}

/** Whether the AI copilot is configured. Drives the chat empty-state + Settings.
 *  Keyed by context: the token lives in the cluster, so switching clusters is a
 *  different answer, not a stale one. */
export function useChatConfig() {
  const context = useCluster((s) => s.activeContext);
  return useQuery({
    queryKey: ["chat-config", context] as const,
    queryFn: fetchChatConfig,
    staleTime: 30_000,
  });
}

/** Set (or clear, with "") the in-app Claude token, then refresh chat-config. */
export function useSetChatToken() {
  const qc = useQueryClient();
  const context = useCluster((s) => s.activeContext);
  return useMutation<ChatConfig, Error, string>({
    mutationFn: async (token) => {
      const res = await apiFetch("/api/chat-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) throw new Error((await res.text()) || "failed to save token");
      return (await res.json()) as ChatConfig;
    },
    onSuccess: (data) => qc.setQueryData(["chat-config", context], data),
  });
}

// ── Agents (multi-backend settings) ──────────────────────────────────────────
export type AgentId = "claude" | "codex" | "gemini" | "opencode";
export type AgentAuthMethod = "subscription" | "apiKey";
export type AgentConnection = "connected" | "notInstalled" | "notSignedIn" | "comingSoon";

export interface AgentView {
  id: AgentId;
  label: string;
  vendor: string;
  status: "available" | "comingSoon";
  connection: AgentConnection;
  authMethods: AgentAuthMethod[];
  authMethod: AgentAuthMethod;
  /** Whether a key is already stored. The key itself never leaves the server. */
  apiKeySet?: boolean;
  installUrl: string;
  installLabel: string;
}
export interface AgentsResponse {
  activeAgentId: AgentId;
  agents: AgentView[];
  /** Which cluster this config belongs to, and whether it could be read. */
  cluster?: ClusterConfigStatus;
}

async function fetchAgents(): Promise<AgentsResponse> {
  const res = await apiFetch("/api/agents");
  if (!res.ok) throw new Error("failed to load agents");
  return (await res.json()) as AgentsResponse;
}

export function useAgents() {
  const context = useCluster((s) => s.activeContext);
  return useQuery({
    queryKey: ["agents", context] as const,
    queryFn: fetchAgents,
    staleTime: 30_000,
  });
}

/**
 * Models + reasoning-effort levels a given agent can run, for the composer's
 * agent-aware model picker. `efforts` is non-empty only for Claude; the others
 * return `[]` (effort is a Claude-only concept). opencode's models are discovered
 * live server-side (`opencode models`), so they can be empty when it isn't
 * installed.
 */
export interface AgentModels {
  models: string[];
  efforts: string[];
}

async function fetchAgentModels(id: AgentId): Promise<AgentModels> {
  const res = await apiFetch(`/api/agents/${id}/models`);
  if (!res.ok) throw new Error("failed to load agent models");
  return (await res.json()) as AgentModels;
}

/** The active agent's selectable models/efforts. Enabled once an id is known. */
export function useAgentModels(agentId: AgentId | undefined) {
  return useQuery({
    queryKey: ["agentModels", agentId] as const,
    queryFn: () => fetchAgentModels(agentId as AgentId),
    enabled: !!agentId,
    staleTime: 5 * 60_000,
  });
}

export interface SetAgentAuthVars {
  id: AgentId;
  authMethod: AgentAuthMethod;
  secret?: string;
}

export function useSetAgentAuth() {
  const qc = useQueryClient();
  return useMutation<AgentView, Error, SetAgentAuthVars>({
    mutationFn: async ({ id, authMethod, secret }) => {
      const res = await apiFetch(`/api/agents/${id}/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authMethod, secret }),
      });
      if (!res.ok) throw new Error((await res.text()) || "failed to save");
      return (await res.json()) as AgentView;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });
}

/** Set the active agent (the one chat/the assistant use), then refresh agents. */
export function useSetActiveAgent() {
  const qc = useQueryClient();
  return useMutation<AgentsResponse, Error, AgentId>({
    mutationFn: async (id) => {
      const res = await apiFetch("/api/agents/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? "Failed to set active agent");
      }
      return (await res.json()) as AgentsResponse;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });
}

export function connectionLabel(c: AgentConnection): string {
  switch (c) {
    case "connected":
      return "Connected";
    case "notInstalled":
      return "Not installed";
    case "notSignedIn":
      return "Not signed in";
    case "comingSoon":
      return "Coming soon";
  }
}

// ---------------------------------------------------------------------------
// Cluster contexts — GET /api/contexts (multi-cluster rail)
// ---------------------------------------------------------------------------

/** A selectable cluster from the server's /api/contexts (mirrors the server's ClusterContext). */
export interface ClusterContext {
  name: string;
  cluster: string;
  server: string;
  active: boolean;
}

async function fetchContexts(): Promise<ClusterContext[]> {
  const res = await apiFetch("/api/contexts");
  if (!res.ok) throw new Error(`failed to load contexts: ${res.status}`);
  const body = (await res.json()) as { contexts?: ClusterContext[] };
  return body.contexts ?? [];
}

/** The kubeconfig contexts (clusters) for the cluster rail. */
export function useContexts() {
  return useQuery({
    queryKey: ["contexts"] as const,
    queryFn: fetchContexts,
    staleTime: 30_000,
  });
}

export interface InstalledContext {
  name: string;
  active: boolean;
}

async function fetchInstalledContexts(namespace: string): Promise<InstalledContext[]> {
  const res = await postAssistant({ action: "installedContexts", namespace });
  const parsed = JSON.parse(res.stdout || "{}") as { contexts?: InstalledContext[] };
  return parsed.contexts ?? [];
}

/** Contexts with the assistant installed — for the Permissions editor's
 *  "Save to all clusters" / "Copy to clusters" scopes. */
export function useInstalledContexts(namespace: string) {
  return useQuery({
    queryKey: ["assistant-installed-contexts", namespace] as const,
    queryFn: () => fetchInstalledContexts(namespace),
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Cluster tools + local cluster management
// ---------------------------------------------------------------------------

export type ClusterOS = "mac" | "windows" | "linux";
export interface ClusterInstaller { id: "brew" | "winget"; present: boolean }
export interface ClusterToolStatus {
  kind: boolean;
  k3d: boolean;
  dockerRunning: boolean;
  os: ClusterOS;
  installer: ClusterInstaller | null;
}

/** Best-effort OS guess for the fallback when the tools probe can't be reached. */
function detectOS(): ClusterOS {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac/i.test(ua)) return "mac";
  return "linux";
}

async function fetchClusterTools(): Promise<ClusterToolStatus> {
  const res = await apiFetch("/api/cluster-tools");
  if (!res.ok) return { kind: false, k3d: false, dockerRunning: false, os: detectOS(), installer: null };
  return (await res.json()) as ClusterToolStatus;
}
export function useClusterTools() {
  return useQuery({ queryKey: ["cluster-tools"] as const, queryFn: fetchClusterTools, staleTime: 5_000 });
}

export function useDeleteCluster() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (context: string) => {
      const res = await apiFetch("/api/cluster/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context }),
      });
      const body = await res.json();
      if (!res.ok || body?.ok === false) throw new Error(body?.error || body?.stderr || "delete failed");
      return body as { ok: boolean; backupPath: string | null };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["contexts"] }),
  });
}

export function useDisconnectCluster() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (context: string) => {
      const res = await apiFetch("/api/cluster/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context }),
      });
      const body = await res.json();
      if (!res.ok || body?.ok === false) throw new Error(body?.error || body?.stderr || "disconnect failed");
      return body as { ok: boolean; backupPath: string | null; removed?: string };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["contexts"] }),
  });
}

// ---- Cloud connect ----

export type { CloudProvider, CloudCluster };
/** The provider check shape, shared with @rigel/cloud-connect (one source of truth). */
export type CloudCheckResult = CheckResult;

/** A 402 { gated: true } response — the server refused because the action needs a
 *  paid plan. Callers can branch on this to show an in-context upgrade prompt. */
export class GatedError extends Error {
  readonly gated = true;
  constructor(message: string) { super(message); this.name = "GatedError"; }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as { error?: string }).error ?? `request failed: ${res.status}`;
    if (res.status === 402 && (data as { gated?: boolean }).gated) throw new GatedError(msg);
    throw new Error(msg);
  }
  return data as T;
}

export const cloudCheck = (provider: CloudProvider) =>
  postJson<CloudCheckResult>("/api/cloud/check", { provider });

export const cloudListClusters = (provider: CloudProvider, params: Record<string, string> = {}) =>
  postJson<{ clusters?: CloudCluster[]; error?: string; stderr?: string }>(
    "/api/cloud/clusters", { provider, params },
  );

export async function cloudConnect(provider: CloudProvider, cluster: CloudCluster, params: Record<string, string> = {}) {
  const r = await postJson<{ context?: string; backupPath?: string | null; error?: string; stderr?: string }>(
    "/api/cloud/connect", { provider, cluster, params },
  );
  if (r.error) throw new Error(r.stderr || r.error);
  return r;
}

export interface ParamOptions { options: string[]; default?: string }
export const cloudParamOptions = (provider: CloudProvider, key: string) =>
  postJson<ParamOptions>("/api/cloud/param-options", { provider, key });

export async function importKubeconfig(kubeconfig: string) {
  const r = await postJson<{ ok: boolean; backupPath?: string | null; added?: string[]; error?: string }>(
    "/api/cloud/import", { kubeconfig },
  );
  if (!r.ok) throw new Error(r.error ?? "import failed");
  return r;
}

export interface VoiceStatus {
  enabled: boolean;
  configured: boolean;
}

/** Drives whether the voice affordance exists at all. A failed request reads as
 * "off" so the header stays quiet on an older server. Keyed by context: the
 * credentials live in the cluster, so "configured" is a per-cluster answer. */
export function useVoiceStatus() {
  const context = useCluster((s) => s.activeContext);
  return useQuery({
    queryKey: ["voice-status", context] as const,
    queryFn: async (): Promise<VoiceStatus> => {
      const res = await apiFetch("/api/voice/status");
      if (!res.ok) return { enabled: false, configured: false };
      return (await res.json()) as VoiceStatus;
    },
    staleTime: 60_000,
  });
}

/** Voice fields the renderer may edit. Mirrors the server's VoiceConfig. */
export type VoiceField =
  | "url" | "apiKey" | "apiSecret" | "openrouterApiKey" | "model" | "sttModel" | "ttsModel";

/** GET /api/voice/config. Secrets are set/unset booleans, never values. */
export interface VoiceConfigView {
  url: string;
  apiKey: string;
  model: string;
  sttModel: string;
  ttsModel: string;
  apiSecretSet: boolean;
  openrouterApiKeySet: boolean;
  /** Field to the env var supplying it. Env wins, so these are not editable. */
  env: Partial<Record<VoiceField, string>>;
  status: VoiceStatus;
  /** The cluster these values live in. Config is per cluster with no local
   *  fallback, so the panel names it and refuses to save without one. */
  cluster: ClusterConfigStatus;
}

/** Keyed by context: the credentials live in the cluster, so switching clusters
 *  asks a different question rather than reusing a stale answer. */
export function useVoiceConfig() {
  const context = useCluster((s) => s.activeContext);
  return useQuery({
    queryKey: ["voice-config", context] as const,
    queryFn: async (): Promise<VoiceConfigView> => {
      const res = await apiFetch("/api/voice/config");
      if (!res.ok) throw new Error(`voice config failed: ${res.status}`);
      return (await res.json()) as VoiceConfigView;
    },
    staleTime: 30_000,
  });
}

/** Save a partial patch. An omitted field is left alone, "" clears it. */
export function useSaveVoiceConfig() {
  const qc = useQueryClient();
  const context = useCluster((s) => s.activeContext);
  return useMutation<VoiceConfigView, Error, Partial<Record<VoiceField, string>>>({
    mutationFn: async (patch) => {
      const res = await apiFetch("/api/voice/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? "failed to save voice settings");
      }
      return (await res.json()) as VoiceConfigView;
    },
    onSuccess: (data) => {
      qc.setQueryData(["voice-config", context], data);
      qc.setQueryData(["voice-status", context], data.status);
    },
  });
}

export interface FailoverConfigView {
  configured: boolean;
  provider: "digitalocean";
  tokenSet: boolean;
  spacesKeySet: boolean;
  spacesSecretSet: boolean;
  region: string;
  nodeSize: string;
  nodeCount: number;
  edge?: FailoverEdgeView;
  cluster: ClusterConfigStatus;
}

export interface FailoverEdgeView {
  host: string;
  backends: Array<{ name: string; ip: string }>;
}

export interface FailoverConfigPatch {
  token?: string;
  spacesKey?: string;
  spacesSecret?: string;
  region?: string;
  nodeSize?: string;
  nodeCount?: number;
  edge?: FailoverEdgeView;
}

export function useFailoverConfig() {
  const context = useCluster((s) => s.activeContext);
  return useQuery({
    queryKey: ["failover-config", context] as const,
    queryFn: async (): Promise<FailoverConfigView> => {
      const res = await apiFetch("/api/failover/config");
      if (!res.ok) throw new Error(`failover config failed: ${res.status}`);
      return (await res.json()) as FailoverConfigView;
    },
    staleTime: 30_000,
  });
}

export interface FailoverSubject {
  kind: string;
  namespace: string;
  name: string;
}

export interface FailoverPlanView {
  members: FailoverSubject[];
  findings: Array<{
    rule: string;
    severity: "blocker" | "rewrite" | "warning";
    subject: FailoverSubject;
    whatsWrong: string;
    rewrite?: { label: string; from: unknown; to: unknown };
  }>;
  plans: Array<{ subject: FailoverSubject; kind: string; bytes?: number; warning?: string }>;
  blockers: FailoverPlanView["findings"];
  outbound: FailoverSubject[];
  workloadsToScale: Array<FailoverSubject & { replicas: number }>;
  endpointRewrites: Array<{
    subject: FailoverSubject;
    key: string;
    from: string;
    to: string;
    via: string;
  }>;
}

export type FailoverStepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface FailoverStepView {
  id: string;
  label: string;
  detail?: string;
  status: FailoverStepStatus;
  error?: string;
}

export interface FailoverLeftBehind {
  clusterId: string;
  context: string;
  at: string;
  error: string;
}

export interface FailoverJobView {
  id?: string;
  startedAt?: string;
  endedAt?: string;
  status: "idle" | "running" | "done" | "failed";
  steps: FailoverStepView[];
  error?: string;
  blockers?: FailoverPlanView["findings"];
  result?: FailoverRunView;
}

export interface FailoverRunView {
  context: string;
  lbAddress: string;
  edgeChange: { host: string; snippet: string; revertSnippet: string; replaceWith: string };
  batchId?: string;
  members: FailoverSubject[];
  data?: {
    steps: Array<{
      kind: string;
      subject: FailoverSubject;
      action: "copied" | "skipped";
      artifacts: string[];
      warning?: string;
    }>;
  };
}

export interface FailoverLiveState {
  leftBehind?: FailoverLeftBehind;
  failedOverTo?: {
    context: string;
    at: string;
    batchId: string;
    lbAddress?: string;
    edgeConfirmed: boolean;
    scaledToZero: Array<FailoverSubject & { replicas: number }>;
  };
}

export function useFailoverState() {
  const context = useCluster((s) => s.activeContext);
  return useQuery({
    queryKey: ["failover-state", context] as const,
    queryFn: async (): Promise<FailoverLiveState> => {
      const res = await apiFetch("/api/failover/state");
      if (!res.ok) throw new Error(`failover state failed: ${res.status}`);
      return (await res.json()) as FailoverLiveState;
    },
    refetchInterval: 15_000,
  });
}

export function useFailoverPlan() {
  const qc = useQueryClient();
  const context = useCluster((s) => s.activeContext);
  return useMutation<FailoverPlanView, Error, { selection: unknown; acceptedRewrites?: unknown[] }>({
    mutationFn: async (body) => {
      const res = await apiFetch("/api/failover/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? "failed to plan failover");
      }
      return (await res.json()) as FailoverPlanView;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["failover-state", context] }),
  });
}

export function useFailoverRun() {
  const qc = useQueryClient();
  const context = useCluster((s) => s.activeContext);
  return useMutation<FailoverJobView, Error, { selection: unknown; acceptedRewrites?: unknown[] }>({
    mutationFn: async (body) => {
      const res = await apiFetch("/api/failover/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as FailoverJobView & { error?: string };
      if (!res.ok) throw new Error(json.error ?? "failover run failed");
      return json;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["failover-job", context] }),
  });
}

/** Polls while a run is in flight. A failover outlives the request that starts it. */
export function useFailoverJob() {
  const context = useCluster((s) => s.activeContext);
  return useQuery<FailoverJobView>({
    queryKey: ["failover-job", context],
    queryFn: async () => {
      const res = await apiFetch("/api/failover/run/status");
      if (!res.ok) throw new Error("could not read the failover job");
      return (await res.json()) as FailoverJobView;
    },
    refetchInterval: (q) => (q.state.data?.status === "running" ? 1500 : false),
  });
}

export function useFailoverEdgeConfirm() {
  const qc = useQueryClient();
  const context = useCluster((s) => s.activeContext);
  return useMutation({
    mutationFn: async () => {
      const res = await apiFetch("/api/failover/confirm-edge", { method: "POST" });
      if (!res.ok) throw new Error("confirm edge failed");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["failover-state", context] }),
  });
}

export function useFailoverScaleHome() {
  const qc = useQueryClient();
  const context = useCluster((s) => s.activeContext);
  return useMutation({
    mutationFn: async () => {
      const res = await apiFetch("/api/failover/scale-home", { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "scale home failed");
      return json;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["failover-state", context] }),
  });
}

export function useFailoverRestore() {
  const qc = useQueryClient();
  const context = useCluster((s) => s.activeContext);
  return useMutation<FailoverJobView, Error, void>({
    mutationFn: async () => {
      const res = await apiFetch("/api/failover/restore", { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as FailoverJobView & { error?: string };
      if (!res.ok) throw new Error(json.error ?? "restore failed");
      return json;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["failover-job", context] }),
  });
}

/** Destroys a cluster that outlived its restore and is still billing. */
export function useFailoverTeardown() {
  const qc = useQueryClient();
  const context = useCluster((s) => s.activeContext);
  return useMutation<{ ok: boolean }, Error, void>({
    mutationFn: async () => {
      const res = await apiFetch("/api/failover/teardown", { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "teardown failed");
      return { ok: true };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["failover-state", context] }),
  });
}

export function useSaveFailoverConfig() {
  const qc = useQueryClient();
  const context = useCluster((s) => s.activeContext);
  return useMutation<FailoverConfigView, Error, FailoverConfigPatch>({
    mutationFn: async (patch) => {
      const res = await apiFetch("/api/failover/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? "failed to save failover destination");
      }
      return (await res.json()) as FailoverConfigView;
    },
    onSuccess: (data) => {
      qc.setQueryData(["failover-config", context], data);
    },
  });
}

export async function fetchVoiceToken(): Promise<{ url: string; token: string }> {
  const res = await apiFetch("/api/voice/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "desktop" }),
  });
  if (!res.ok) throw new Error(`voice token failed: ${res.status}`);
  return (await res.json()) as { url: string; token: string };
}

export interface ClusterHealth { ok: boolean; authExpired: boolean }

/** Poll a connected cloud context's health to drive the "Needs re-login" badge. */
export function useClusterHealth(context: string | null, provider: string, enabled: boolean) {
  return useQuery({
    queryKey: ["cluster-health", context] as const,
    queryFn: () => postJson<ClusterHealth>("/api/cloud/health", { provider, context }),
    enabled: enabled && !!context,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}
