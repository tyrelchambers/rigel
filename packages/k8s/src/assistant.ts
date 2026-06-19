// Assistant agent installer manifests + status derivation. Direct port of the
// Swift source of truth (`Sources/Helmsman/Panels/Assistant/`):
//   - AssistantInstaller.swift  → manifest/secret/namespace YAML builders
//   - TokenExpiry.swift         → token-expiry countdown
//   - AssistantState.swift      → decode-only state.json shape
//
// The RBAC-cage invariant holds: nothing the installer applies grants access to
// the `secrets` resource (the token is injected via a single `secretKeyRef`).
//
// See docs/parity/assistant.md for the normative web spec and
// docs/parity/contracts.md for the shared action-block protocol used by queued
// suggestions and revert.

import type { SuggestedAction } from "./actionBlocks";

// ---------------------------------------------------------------------------
// Install configuration (mirrors Swift AssistantInstallConfig)
// ---------------------------------------------------------------------------

export interface AssistantInstallConfig {
  image: string;
  /**
   * Namespace the agent is installed INTO (its SA/RBAC/ConfigMaps/Secret/
   * Deployment). The agent still watches the whole cluster via its ClusterRole.
   */
  installNamespace: string;
  /** Comma-separated namespaces to scope remediation to; empty = all. */
  namespaces: string;
  workerModel: string;
  supervisorModel: string;
  spendCapUsd: number;
  pollIntervalMs: number;
  maxPerResourcePerHour: number;
  maxPerNight: number;
  maxAttemptsPerIncident: number;
  confirmPolls: number;
}

/** Defaults baked into the install form (mirrors `AssistantInstallConfig.default`). */
export const DEFAULT_INSTALL_CONFIG: AssistantInstallConfig = {
  image: "ghcr.io/tyrelchambers/helmsman-assistant:latest",
  installNamespace: "default",
  namespaces: "",
  workerModel: "claude-sonnet-4-6",
  supervisorModel: "claude-opus-4-8",
  spendCapUsd: 50,
  pollIntervalMs: 30000,
  maxPerResourcePerHour: 3,
  maxPerNight: 20,
  maxAttemptsPerIncident: 3,
  confirmPolls: 2,
};

export const SECRET_NAME = "assistant-claude-token";
/** Annotation the installer stamps on the token Secret at mint time. */
export const ISSUED_AT_ANNOTATION = "helmsman.assistant/token-issued-at";

// ---------------------------------------------------------------------------
// Manifest builders — byte-for-byte port of AssistantInstaller.swift
// ---------------------------------------------------------------------------

/** YAML-escape a token for a double-quoted stringData value. */
function escape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Standalone Namespace object, applied (after confirmation) when installing into
 * a namespace that doesn't exist yet.
 */
export function namespaceYAML(ns: string): string {
  return `apiVersion: v1
kind: Namespace
metadata:
  name: ${ns}
  labels:
    app.kubernetes.io/managed-by: helmsman-assistant`;
}

/**
 * Token Secret. Applied separately before the rest of the manifests so a bad
 * token can be rolled back without reapplying RBAC. Never shown in the preview.
 */
export function secretYAML(token: string, issuedAt = "", namespace = "default"): string {
  return `apiVersion: v1
kind: Secret
metadata:
  name: ${SECRET_NAME}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/managed-by: helmsman-assistant
  annotations:
    ${ISSUED_AT_ANNOTATION}: "${issuedAt}"
type: Opaque
stringData:
  token: "${escape(token)}"`;
}

/** ServiceAccount + ClusterRole + ClusterRoleBinding + namespaced Role/RoleBinding. */
export function rbac(ns: string): string {
  return `apiVersion: v1
kind: ServiceAccount
metadata:
  name: helmsman-assistant
  namespace: ${ns}
  labels:
    app.kubernetes.io/managed-by: helmsman-assistant
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: helmsman-assistant
  labels:
    app.kubernetes.io/managed-by: helmsman-assistant
rules:
  - apiGroups: [""]
    resources: [pods, pods/log, nodes, events, namespaces, services, endpoints, persistentvolumeclaims, persistentvolumes, replicationcontrollers, configmaps]
    verbs: [get, list, watch]
  - apiGroups: ["apps"]
    resources: [deployments, replicasets, statefulsets, daemonsets]
    verbs: [get, list, watch]
  - apiGroups: ["batch"]
    resources: [jobs, cronjobs]
    verbs: [get, list, watch]
  - apiGroups: ["metrics.k8s.io"]
    resources: [pods, nodes]
    verbs: [get, list]
  - apiGroups: ["apps"]
    resources: [deployments]
    verbs: [patch, update]
  - apiGroups: ["apps"]
    resources: [deployments/scale]
    verbs: [patch, update]
  - apiGroups: [""]
    resources: [pods]
    verbs: [delete]
  - apiGroups: [""]
    resources: [nodes]
    verbs: [patch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: helmsman-assistant
  labels:
    app.kubernetes.io/managed-by: helmsman-assistant
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: helmsman-assistant
subjects:
  - kind: ServiceAccount
    name: helmsman-assistant
    namespace: ${ns}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: helmsman-assistant-state
  namespace: ${ns}
  labels:
    app.kubernetes.io/managed-by: helmsman-assistant
rules:
  - apiGroups: [""]
    resources: [configmaps]
    resourceNames: [assistant-config, assistant-state, assistant-backups]
    verbs: [get, update, patch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: helmsman-assistant-state
  namespace: ${ns}
  labels:
    app.kubernetes.io/managed-by: helmsman-assistant
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: helmsman-assistant-state
subjects:
  - kind: ServiceAccount
    name: helmsman-assistant
    namespace: ${ns}`;
}

/** The three pre-created ConfigMaps: config (control surface), state, backups. */
export function configMaps(ns: string): string {
  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: assistant-config
  namespace: ${ns}
  labels:
    app.kubernetes.io/managed-by: helmsman-assistant
data:
  enabled: "true"
  mode: "auto"
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: assistant-state
  namespace: ${ns}
  labels:
    app.kubernetes.io/managed-by: helmsman-assistant
data: {}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: assistant-backups
  namespace: ${ns}
  labels:
    app.kubernetes.io/managed-by: helmsman-assistant
data: {}`;
}

/** The agent Deployment (replicas:1, Recreate, RBAC cage, env from config). */
export function deployment(c: AssistantInstallConfig): string {
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: helmsman-assistant
  namespace: ${c.installNamespace}
  labels:
    app.kubernetes.io/name: helmsman-assistant
    app.kubernetes.io/managed-by: helmsman-assistant
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app.kubernetes.io/name: helmsman-assistant
  template:
    metadata:
      labels:
        app.kubernetes.io/name: helmsman-assistant
    spec:
      serviceAccountName: helmsman-assistant
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
        # Unconfined is required: Claude Code's Bun runtime crashes during
        # GC under RuntimeDefault on kernel 6.17 (it needs thread-suspension
        # syscalls the default profile filters). The agent is still caged by
        # non-root + dropped caps + tightly-scoped RBAC.
        seccompProfile:
          type: Unconfined
      containers:
        - name: agent
          image: "${c.image}"
          imagePullPolicy: IfNotPresent
          env:
            - name: CLAUDE_CODE_OAUTH_TOKEN
              valueFrom:
                secretKeyRef:
                  name: ${SECRET_NAME}
                  key: token
            - name: WORKER_MODEL
              value: "${c.workerModel}"
            - name: SUPERVISOR_MODEL
              value: "${c.supervisorModel}"
            - name: POLL_INTERVAL_MS
              value: "${c.pollIntervalMs}"
            - name: SPEND_CAP_USD
              value: "${c.spendCapUsd}"
            - name: MAX_PER_RESOURCE_PER_HOUR
              value: "${c.maxPerResourcePerHour}"
            - name: MAX_PER_NIGHT
              value: "${c.maxPerNight}"
            - name: MAX_ATTEMPTS_PER_INCIDENT
              value: "${c.maxAttemptsPerIncident}"
            - name: CONFIRM_POLLS
              value: "${c.confirmPolls}"
            - name: NAMESPACES
              value: "${c.namespaces}"
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
          resources:
            requests:
              cpu: 50m
              memory: 128Mi
            limits:
              cpu: "1"
              memory: 512Mi`;
}

/** The previewable manifest: RBAC + ConfigMaps + Deployment (NO Secret). */
export function manifestYAML(c: AssistantInstallConfig): string {
  return [rbac(c.installNamespace), configMaps(c.installNamespace), deployment(c)].join("\n---\n");
}

/**
 * Replace the token line in a Secret YAML with `***SECRET***` for preview. The
 * panel never previews the Secret YAML at all (it shows only manifestYAML), but
 * this guards any path that might render a token-bearing string.
 */
export function maskToken(yaml: string): string {
  return yaml.replace(/(token:\s*)"(?:[^"\\]|\\.)*"/g, '$1"***SECRET***"');
}

// ---------------------------------------------------------------------------
// Token expiry (mirrors Swift TokenExpiry)
// ---------------------------------------------------------------------------

export const TOKEN_LIFETIME_DAYS = 365;
export const TOKEN_WARN_WITHIN_DAYS = 30;

export type TokenExpiryLevel = "ok" | "warning" | "expired";

export interface TokenExpiryStatus {
  daysRemaining: number;
  level: TokenExpiryLevel;
}

/**
 * Days-remaining countdown for the OAuth token, given its mint date. Floors the
 * remaining days (matches Swift `.rounded(.down)`); `<= 0` is expired, `<= 30`
 * warns, otherwise ok.
 */
export function tokenExpiryStatus(issuedAt: Date, now: Date): TokenExpiryStatus {
  const expiryMs = issuedAt.getTime() + TOKEN_LIFETIME_DAYS * 86_400_000;
  const remaining = Math.floor((expiryMs - now.getTime()) / 86_400_000);
  let level: TokenExpiryLevel;
  if (remaining <= 0) level = "expired";
  else if (remaining <= TOKEN_WARN_WITHIN_DAYS) level = "warning";
  else level = "ok";
  return { daysRemaining: remaining, level };
}

/**
 * Token expiry from a Secret's issued-at annotation (the raw ISO-8601 string the
 * installer stamped). Returns null when the annotation is missing/unparseable.
 */
export function parseTokenExpiry(issuedAtISO: string | undefined, now: Date): TokenExpiryStatus | null {
  if (!issuedAtISO || issuedAtISO.trim() === "") return null;
  const ms = Date.parse(issuedAtISO);
  if (Number.isNaN(ms)) return null;
  return tokenExpiryStatus(new Date(ms), now);
}

// ---------------------------------------------------------------------------
// Agent state surface (decode-only; mirrors Swift AssistantState.swift)
// ---------------------------------------------------------------------------

export interface AssistantAgentStatus {
  heartbeatAt: string;
  spentUsd: number;
  spendCapUsd: number;
  enabled: boolean;
  version: string;
}

export interface AssistantAuditEntry {
  at: string;
  fingerprint: string;
  incident: string;
  proposal?: string;
  command?: string;
  tier: string;
  verdict?: string;
  outcome: string;
  detail: string;
  backupRef?: string;
  analysis?: string;
}

export interface AssistantQueuedSuggestion {
  at: string;
  incident: string;
  suggestion: string;
  reason: string;
  action?: SuggestedAction;
}

export interface AssistantClusterState {
  updatedAt?: string;
  status?: AssistantAgentStatus;
  audit: AssistantAuditEntry[];
  queue: AssistantQueuedSuggestion[];
  report: string;
}

/**
 * Decode the agent-owned `state.json` blob (from the `assistant-state`
 * ConfigMap). All collection/string fields default to empty when absent, exactly
 * like the Swift `AssistantClusterState.init(from:)`. Returns null on parse
 * failure.
 */
export function decodeClusterState(raw: string | undefined | null): AssistantClusterState | null {
  if (!raw) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  return {
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : undefined,
    status: (o.status as AssistantAgentStatus | undefined) ?? undefined,
    audit: Array.isArray(o.audit) ? (o.audit as AssistantAuditEntry[]) : [],
    queue: Array.isArray(o.queue) ? (o.queue as AssistantQueuedSuggestion[]) : [],
    report: typeof o.report === "string" ? o.report : "",
  };
}

/** Stable identity for an audit entry (mirrors Swift `id`). */
export function auditEntryId(e: AssistantAuditEntry): string {
  return `${e.at}|${e.fingerprint}|${e.proposal ?? ""}|${e.outcome}`;
}

/** Stable identity for a queued suggestion (mirrors Swift `id`). */
export function queuedSuggestionId(q: AssistantQueuedSuggestion): string {
  return `${q.at}|${q.incident}|${q.suggestion}`;
}

// ---------------------------------------------------------------------------
// Config (assistant-config) parsing helpers — the live control surface
// ---------------------------------------------------------------------------

/** Kill-switch: on unless explicitly "false" (matches Swift `enabled`). */
export function isEnabled(configData: Record<string, string>): boolean {
  return configData["enabled"] !== "false";
}

/** Autonomy mode; defaults to "auto" when missing. */
export function autonomyMode(configData: Record<string, string>): string {
  return configData["mode"] ?? "auto";
}

/** Quiet-hours window ("HH:MM-HH:MM"); empty when unset. */
export function quietWindow(configData: Record<string, string>): string {
  return configData["window"] ?? "";
}

/** Parse the newline/comma-separated silenced fingerprint list into a set. */
export function silencedSet(configData: Record<string, string>): Set<string> {
  return new Set(
    (configData["silenced"] ?? "")
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

// ---------------------------------------------------------------------------
// Live issues (current cluster state, independent of the agent)
// ---------------------------------------------------------------------------

const ERROR_WAITING_REASONS = new Set([
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "ErrImagePull",
  "CreateContainerConfigError",
  "RunContainerError",
  "InvalidImageName",
]);

/**
 * Human-readable error reason for a pod, or null when healthy. Mirrors Swift
 * `Pod.errorReason`: a "Failed" phase, or any container waiting on a known
 * error reason.
 */
export function podErrorReason(pod: {
  status?: { phase?: string; containerStatuses?: Array<{ state?: { waiting?: { reason?: string } } }> };
}): string | null {
  if (pod.status?.phase === "Failed") return "Failed";
  for (const cs of pod.status?.containerStatuses ?? []) {
    const reason = cs.state?.waiting?.reason;
    if (reason && ERROR_WAITING_REASONS.has(reason)) return reason;
  }
  return null;
}

export interface AssistantLiveIssue {
  location: string;
  reason: string;
  /** Matches the agent's incident fingerprint so it can be silenced. */
  fingerprint: string;
}

interface LiveIssuePod {
  metadata: { name: string; namespace?: string };
  status?: { phase?: string; containerStatuses?: Array<{ state?: { waiting?: { reason?: string } } }> };
}

interface LiveIssueDeployment {
  metadata: { name: string; namespace?: string };
  spec?: { replicas?: number };
  status?: { replicas?: number; readyReplicas?: number };
}

/**
 * What the cluster looks like right now — the incidents the agent is (or should
 * be) reacting to. Direct port of Swift `AssistantViewModel.liveIssues`.
 *   - any pod with an `errorReason`
 *   - any deployment with desired > 0 and ready < desired
 * Fingerprints match the agent's: `unhealthyPod|{ns}|{pod}|{reason}` and
 * `degradedDeployment|{ns}|{deployment}|Degraded`.
 */
export function computeLiveIssues(
  pods: LiveIssuePod[],
  deployments: LiveIssueDeployment[],
): AssistantLiveIssue[] {
  const out: AssistantLiveIssue[] = [];
  for (const p of pods) {
    const reason = podErrorReason(p);
    if (reason) {
      const ns = p.metadata.namespace ?? "default";
      out.push({
        location: `${ns}/${p.metadata.name}`,
        reason,
        fingerprint: `unhealthyPod|${ns}|${p.metadata.name}|${reason}`,
      });
    }
  }
  for (const d of deployments) {
    const desired = d.spec?.replicas ?? d.status?.replicas ?? 0;
    const ready = d.status?.readyReplicas ?? 0;
    if (desired > 0 && ready < desired) {
      const ns = d.metadata.namespace ?? "default";
      out.push({
        location: `${ns}/${d.metadata.name}`,
        reason: `Degraded ${ready}/${desired}`,
        fingerprint: `degradedDeployment|${ns}|${d.metadata.name}|Degraded`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// ConfigMap read-modify-write helpers
// ---------------------------------------------------------------------------

/**
 * Merge `updates` over the existing `assistant-config` data and produce the full
 * ConfigMap JSON to apply. Read-modify-write so changing one key never clobbers
 * the others (kill-switch / mode / silenced…). Mirrors Swift `patchConfig`.
 */
export function mergedConfigMapJSON(
  namespace: string,
  existingData: Record<string, string>,
  updates: Record<string, string>,
): string {
  const data: Record<string, string> = { ...existingData, ...updates };
  return JSON.stringify({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: "assistant-config",
      namespace,
      labels: { "app.kubernetes.io/managed-by": "helmsman-assistant" },
    },
    data,
  });
}

/**
 * Produce the `assistant-state` ConfigMap JSON with `patch` shallow-merged into
 * the parsed state.json (the rest of state is preserved). Returns null when the
 * existing state.json is missing/unparseable (nothing to clear).
 */
export function clearedStateConfigMapJSON(
  namespace: string,
  stateJSON: string | undefined | null,
  patch: Record<string, unknown>,
): string | null {
  if (!stateJSON) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(stateJSON);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const next = { ...(obj as Record<string, unknown>), ...patch };
  return JSON.stringify({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: "assistant-state",
      namespace,
      labels: { "app.kubernetes.io/managed-by": "helmsman-assistant" },
    },
    data: { "state.json": JSON.stringify(next) },
  });
}

/**
 * Produce the `assistant-state` ConfigMap JSON with `report` cleared.
 * Mirrors Swift `clearReport`.
 */
export function clearedReportConfigMapJSON(
  namespace: string,
  stateJSON: string | undefined | null,
): string | null {
  return clearedStateConfigMapJSON(namespace, stateJSON, { report: "" });
}
