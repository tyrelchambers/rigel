// Assistant agent installer manifests + status derivation. Direct port of the
// Swift source of truth (`Sources/Rigel/Panels/Assistant/`):
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
  pollIntervalMs: number;
  maxPerResourcePerHour: number;
  maxPerNight: number;
  maxAttemptsPerIncident: number;
  confirmPolls: number;
  /** Per-role provider+model+effort selections seeded into assistant-config on
   * install. Optional: when absent the ConfigMap seeds claude worker/supervisor
   * (matching the WORKER_MODEL/SUPERVISOR_MODEL env fallbacks). */
  worker?: RoleSelectionInput;
  supervisor?: RoleSelectionInput;
}

/** Defaults baked into the install form (mirrors `AssistantInstallConfig.default`). */
export const DEFAULT_INSTALL_CONFIG: AssistantInstallConfig = {
  image: "ghcr.io/tyrelchambers/rigel-assistant:latest",
  installNamespace: "default",
  namespaces: "",
  workerModel: "claude-sonnet-4-6",
  supervisorModel: "claude-opus-4-8",
  pollIntervalMs: 30000,
  maxPerResourcePerHour: 3,
  maxPerNight: 20,
  maxAttemptsPerIncident: 3,
  confirmPolls: 2,
};

// Agent-agnostic name — the assistant supports multiple AI backends, so the
// Secret isn't Claude-specific (it just holds the active agent's credential).
export const SECRET_NAME = "rigel-assistant-token";
/** Annotation the installer stamps on the token Secret at mint time. */
export const ISSUED_AT_ANNOTATION = "rigel.assistant/token-issued-at";

/** Multi-key Secret holding one entry per provider credential the user supplied.
 * Distinct from the legacy single-key SECRET_NAME so existing installs are
 * untouched (the Deployment injects from BOTH, each optional). */
export const CREDENTIALS_SECRET_NAME = "rigel-assistant-credentials";

/** The agent Deployment's name. Its owned objects all carry the managed-by label
 *  below, so we can tell OUR install apart from a same-named foreign Deployment. */
export const DEPLOYMENT_NAME = "rigel-assistant";

/** True when an object's labels mark it as managed by the Rigel assistant. Lets
 *  discovery + install avoid adopting or operating on a same-named object we
 *  don't own (`kubectl apply` would otherwise silently merge into it). */
export function isAssistantManaged(labels?: Record<string, string>): boolean {
  return labels?.["app.kubernetes.io/managed-by"] === "rigel-assistant";
}

/** The provider credentials a user can supply. Each maps to one Secret key and,
 * via the Deployment env, to the exact var the matching bridge's authEnv() reads:
 *   claudeToken          → CLAUDE_CODE_OAUTH_TOKEN  (claude)
 *   anthropicApiKey      → ANTHROPIC_API_KEY        (claude fallback)
 *   codexApiKey          → CODEX_API_KEY            (codex fallback)
 *   codexAuthContent     → CODEX_AUTH_CONTENT       (codex preferred; ~/.codex/auth.json)
 *   geminiApiKey         → GEMINI_API_KEY           (gemini)
 *   opencodeApiKey       → OPENCODE_API_KEY         (opencode fallback)
 *   opencodeAuthContent  → OPENCODE_AUTH_CONTENT    (opencode preferred) */
export interface AssistantCredentials {
  claudeToken?: string;
  anthropicApiKey?: string;
  codexApiKey?: string;
  codexAuthContent?: string;
  geminiApiKey?: string;
  opencodeApiKey?: string;
  opencodeAuthContent?: string;
}

/** Stable ordered list of (key) so YAML output is deterministic. */
const CREDENTIAL_KEYS: (keyof AssistantCredentials)[] = [
  "claudeToken",
  "anthropicApiKey",
  "codexApiKey",
  "codexAuthContent",
  "geminiApiKey",
  "opencodeApiKey",
  "opencodeAuthContent",
];

/** Discovery label a Secret carries to participate as a credential source, so
 *  resolution can `kubectl get secrets -l <this>=true` instead of fixed names. */
export const CREDENTIAL_STORE_LABEL = "rigel.assistant/credential-store";
/** Per-credential correlation annotation prefix: `<prefix><id>: "<dataKey>"`
 *  declares "my data key <dataKey> provides credential <id>". */
export const CREDENTIAL_ANNOTATION_PREFIX = "rigel.assistant/credential.";

/** Canonical provider credential → the agent env var it feeds + its default
 *  managed source. The single source of truth for resolution + env render. */
export interface CredentialEnvEntry {
  id: keyof AssistantCredentials;
  env: string;
  defaultSecret: string; // SECRET_NAME for claudeToken, else CREDENTIALS_SECRET_NAME
  defaultKey: string;    // data key in the default Secret
}

/** Ordered to mirror today's Deployment env exactly (and CREDENTIAL_KEYS). */
export const CREDENTIAL_ENV: CredentialEnvEntry[] = [
  { id: "claudeToken",         env: "CLAUDE_CODE_OAUTH_TOKEN", defaultSecret: SECRET_NAME,             defaultKey: "token" },
  { id: "anthropicApiKey",     env: "ANTHROPIC_API_KEY",       defaultSecret: CREDENTIALS_SECRET_NAME, defaultKey: "anthropicApiKey" },
  { id: "codexApiKey",         env: "CODEX_API_KEY",           defaultSecret: CREDENTIALS_SECRET_NAME, defaultKey: "codexApiKey" },
  { id: "codexAuthContent",    env: "CODEX_AUTH_CONTENT",      defaultSecret: CREDENTIALS_SECRET_NAME, defaultKey: "codexAuthContent" },
  { id: "geminiApiKey",        env: "GEMINI_API_KEY",          defaultSecret: CREDENTIALS_SECRET_NAME, defaultKey: "geminiApiKey" },
  { id: "opencodeApiKey",      env: "OPENCODE_API_KEY",        defaultSecret: CREDENTIALS_SECRET_NAME, defaultKey: "opencodeApiKey" },
  { id: "opencodeAuthContent", env: "OPENCODE_AUTH_CONTENT",   defaultSecret: CREDENTIALS_SECRET_NAME, defaultKey: "opencodeAuthContent" },
];

/** The set of valid credential ids, for fast membership checks. */
const CREDENTIAL_IDS = new Set<string>(CREDENTIAL_ENV.map((e) => e.id));

/** Minimal shape of a Secret as resolution needs it (a `kubectl get -o json`
 *  item, with `data` base64-encoded — we only ever check key presence + that the
 *  encoded value is a non-empty string, never decode/log a value). */
export interface SecretLike {
  metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  data?: Record<string, string>;
}

/** Where a resolved credential is backed: a Secret name + data key, plus whether
 *  that key currently holds a non-empty value. Never carries the value itself. */
export interface ResolvedSource {
  secretName: string;
  dataKey: string;
  hasValue: boolean;
}

export interface CredentialResolution {
  sources: Partial<Record<keyof AssistantCredentials, ResolvedSource>>;
  /** Credential ids claimed by more than one credential-store Secret (the
   *  alphabetically-first Secret won; surfaced so the UI can warn, never silent). */
  conflicts: (keyof AssistantCredentials)[];
}

/** True when the Secret's `data` holds a non-empty (base64) value for `key`. */
function hasNonEmptyData(secret: SecretLike, key: string): boolean {
  const v = secret.data?.[key];
  return typeof v === "string" && v !== "";
}

/**
 * Resolve, per credential id, the backing `{ secretName, dataKey, hasValue }`:
 *
 *  1. Annotations first: every Secret carrying `rigel.assistant/credential-store=true`
 *     contributes each `rigel.assistant/credential.<id>` annotation as a candidate.
 *     Single owner per id — if >1 Secret claims one id, the alphabetically-first
 *     (by Secret name) wins and the id is reported in `conflicts`. Unknown ids are
 *     ignored.
 *  2. Legacy fallback: for any id with no annotated source, fall back to
 *     CREDENTIAL_ENV's default Secret name + key (so un-migrated installs keep
 *     working until re-stamped). Annotations always win over the fallback.
 *
 * Pure — never touches the cluster, never returns/logs a secret value.
 */
export function resolveCredentialSources(secrets: SecretLike[]): CredentialResolution {
  const sources: Partial<Record<keyof AssistantCredentials, ResolvedSource>> = {};
  const conflicts: (keyof AssistantCredentials)[] = [];

  // 1. Annotation-driven candidates from credential-store Secrets, processed in
  //    alphabetical Secret-name order so the first claimant wins deterministically.
  const stores = secrets
    .filter((s) => s.metadata.labels?.[CREDENTIAL_STORE_LABEL] === "true")
    .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  for (const secret of stores) {
    for (const [annKey, dataKey] of Object.entries(secret.metadata.annotations ?? {})) {
      if (!annKey.startsWith(CREDENTIAL_ANNOTATION_PREFIX)) continue;
      const id = annKey.slice(CREDENTIAL_ANNOTATION_PREFIX.length);
      if (!CREDENTIAL_IDS.has(id)) continue; // unknown credential id — ignore
      const cid = id as keyof AssistantCredentials;
      if (sources[cid]) {
        // Already claimed by an earlier (alphabetically-first) Secret.
        if (!conflicts.includes(cid)) conflicts.push(cid);
        continue;
      }
      sources[cid] = {
        secretName: secret.metadata.name,
        dataKey,
        hasValue: hasNonEmptyData(secret, dataKey),
      };
    }
  }

  // 2. Legacy fallback for any id with no annotated source.
  const byName = new Map(secrets.map((s) => [s.metadata.name, s]));
  for (const entry of CREDENTIAL_ENV) {
    if (sources[entry.id]) continue;
    const secret = byName.get(entry.defaultSecret);
    if (!secret) continue;
    if (!(entry.defaultKey in (secret.data ?? {}))) continue;
    sources[entry.id] = {
      secretName: entry.defaultSecret,
      dataKey: entry.defaultKey,
      hasValue: hasNonEmptyData(secret, entry.defaultKey),
    };
  }

  return { sources, conflicts };
}

/** All credential-store Secret names that currently annotate `credentialId`
 *  (i.e. carry `rigel.assistant/credential.<id>`), in alphabetical name order. */
function secretsClaimingCredential(
  secrets: SecretLike[],
  credentialId: keyof AssistantCredentials,
): string[] {
  const annKey = `${CREDENTIAL_ANNOTATION_PREFIX}${credentialId}`;
  return secrets
    .filter(
      (s) =>
        s.metadata.labels?.[CREDENTIAL_STORE_LABEL] === "true" &&
        annKey in (s.metadata.annotations ?? {}),
    )
    .map((s) => s.metadata.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Pure kubectl argv builders for repointing a credential at a chosen Secret.
 * Returns `string[][]` (one argv per command); runs NOTHING and never carries a
 * secret value — only the credential id, Secret names, and data key name.
 *
 * For `setCredentialSource({ credentialId, secretName, dataKey }, currentSecrets, namespace)`:
 *  1. label the chosen Secret as a credential-store,
 *  2. annotate it `rigel.assistant/credential.<id>=<dataKey>`,
 *  3. remove that annotation from every OTHER credential-store Secret claiming
 *     the id (single-owner per credential).
 */
export function credentialSourceCommands(
  choice: { credentialId: keyof AssistantCredentials; secretName: string; dataKey: string },
  currentSecrets: SecretLike[],
  namespace: string,
): string[][] {
  const { credentialId, secretName, dataKey } = choice;
  const annKey = `${CREDENTIAL_ANNOTATION_PREFIX}${credentialId}`;
  const cmds: string[][] = [
    ["label", "secret", secretName, `${CREDENTIAL_STORE_LABEL}=true`, "--overwrite", "-n", namespace],
    ["annotate", "secret", secretName, `${annKey}=${dataKey}`, "--overwrite", "-n", namespace],
  ];
  // Single-owner: strip the id annotation from every other claimant.
  for (const sibling of secretsClaimingCredential(currentSecrets, credentialId)) {
    if (sibling === secretName) continue;
    cmds.push(["annotate", "secret", sibling, `${annKey}-`, "-n", namespace]);
  }
  return cmds;
}

/**
 * Pure kubectl argv builders to clear a credential's BYO source so resolution
 * falls back to the managed default: remove the `rigel.assistant/credential.<id>`
 * annotation from EVERY credential-store Secret EXCEPT the managed default
 * (CREDENTIAL_ENV's defaultSecret for the id), which keeps the legacy mapping
 * intact. Returns `string[][]`; runs nothing.
 */
export function clearCredentialSourceCommands(
  credentialId: keyof AssistantCredentials,
  currentSecrets: SecretLike[],
  namespace: string,
): string[][] {
  const annKey = `${CREDENTIAL_ANNOTATION_PREFIX}${credentialId}`;
  const managedDefault = CREDENTIAL_ENV.find((e) => e.id === credentialId)?.defaultSecret;
  return secretsClaimingCredential(currentSecrets, credentialId)
    .filter((name) => name !== managedDefault)
    .map((name) => ["annotate", "secret", name, `${annKey}-`, "-n", namespace]);
}

/** Every credential id currently claimed by SOME credential-store Secret's
 *  `rigel.assistant/credential.<id>` annotation (any claimant, valid id only). */
function annotationClaimedIds(secrets: SecretLike[]): Set<keyof AssistantCredentials> {
  const claimed = new Set<keyof AssistantCredentials>();
  for (const secret of secrets) {
    if (secret.metadata.labels?.[CREDENTIAL_STORE_LABEL] !== "true") continue;
    for (const annKey of Object.keys(secret.metadata.annotations ?? {})) {
      if (!annKey.startsWith(CREDENTIAL_ANNOTATION_PREFIX)) continue;
      const id = annKey.slice(CREDENTIAL_ANNOTATION_PREFIX.length);
      if (CREDENTIAL_IDS.has(id)) claimed.add(id as keyof AssistantCredentials);
    }
  }
  return claimed;
}

/**
 * Pure kubectl argv builders that make a LEGACY install's fallback resolution
 * explicit: for each CREDENTIAL_ENV id whose default Secret exists, holds the
 * default key, AND is NOT already annotation-claimed by ANY credential-store
 * Secret, emit a label (`rigel.assistant/credential-store=true`) + an annotate
 * (`rigel.assistant/credential.<id>=<defaultKey>`). One `label` command per
 * Secret (shared across its ids).
 *
 * Conflict-safe by construction: an id any Secret already claims is skipped, so
 * reconcile can never create a second claimant. Idempotent: already-stamped or
 * absent ids produce nothing. Changes Secret METADATA ONLY — never an apply,
 * rollout, restart, or patch — since the Deployment env already points at these
 * Secrets. Runs nothing and never carries a value (ids + names + key names only).
 */
export function reconcileCommands(secrets: SecretLike[], namespace: string): string[][] {
  const claimed = annotationClaimedIds(secrets);
  const byName = new Map(secrets.map((s) => [s.metadata.name, s]));
  const labelled = new Set<string>(); // default Secret names already given a label cmd
  const cmds: string[][] = [];
  for (const entry of CREDENTIAL_ENV) {
    if (claimed.has(entry.id)) continue; // already annotation-driven → leave alone
    const secret = byName.get(entry.defaultSecret);
    if (!secret) continue; // no default Secret → nothing to stamp
    if (!(entry.defaultKey in (secret.data ?? {}))) continue; // missing default key
    if (!labelled.has(entry.defaultSecret)) {
      cmds.push(["label", "secret", entry.defaultSecret, `${CREDENTIAL_STORE_LABEL}=true`, "--overwrite", "-n", namespace]);
      labelled.add(entry.defaultSecret);
    }
    cmds.push(["annotate", "secret", entry.defaultSecret, `${CREDENTIAL_ANNOTATION_PREFIX}${entry.id}=${entry.defaultKey}`, "--overwrite", "-n", namespace]);
  }
  return cmds;
}

/** True when `reconcileCommands` would emit anything (a legacy install has
 *  fallback-resolved credentials not yet made explicit via annotations). */
export function needsReconcile(secrets: SecretLike[]): boolean {
  return reconcileCommands(secrets, "x").length > 0;
}

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
    app.kubernetes.io/managed-by: rigel-assistant`;
}

/**
 * Token Secret. Applied separately before the rest of the manifests so a bad
 * token can be rolled back without reapplying RBAC. Never shown in the preview.
 */
export function secretYAML(token: string, issuedAt = "", namespace = "default"): string {
  const claudeKey = CREDENTIAL_ENV.find((e) => e.id === "claudeToken")!.defaultKey;
  return `apiVersion: v1
kind: Secret
metadata:
  name: ${SECRET_NAME}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/managed-by: rigel-assistant
    ${CREDENTIAL_STORE_LABEL}: "true"
  annotations:
    ${ISSUED_AT_ANNOTATION}: "${issuedAt}"
    ${CREDENTIAL_ANNOTATION_PREFIX}claudeToken: "${claudeKey}"
type: Opaque
stringData:
  ${claudeKey}: "${escape(token)}"`;
}

/**
 * The multi-key credentials Secret. Writes ONLY the keys whose value is a
 * non-empty string, so a user who supplies one provider's key gets a Secret with
 * just that key. The Deployment references every possible key with
 * `optional: true`, so absent keys are simply not injected (no startup failure).
 * Never previewed (carries secrets), same as secretYAML.
 */
export function credentialsSecretYAML(
  creds: AssistantCredentials,
  namespace = "default",
): string {
  const lines: string[] = [];
  const annotations: string[] = [];
  for (const key of CREDENTIAL_KEYS) {
    const value = creds[key];
    if (typeof value === "string" && value.trim() !== "") {
      lines.push(`  ${key}: "${escape(value)}"`);
      // Correlate this data key to its credential id. For the credentials Secret
      // the data key IS the id, so the annotation value mirrors the key name.
      annotations.push(`    ${CREDENTIAL_ANNOTATION_PREFIX}${key}: "${key}"`);
    }
  }
  const stringData = lines.length > 0 ? `stringData:\n${lines.join("\n")}` : "stringData: {}";
  const annotationsBlock = annotations.length > 0 ? `\n  annotations:\n${annotations.join("\n")}` : "";
  return `apiVersion: v1
kind: Secret
metadata:
  name: ${CREDENTIALS_SECRET_NAME}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/managed-by: rigel-assistant
    ${CREDENTIAL_STORE_LABEL}: "true"${annotationsBlock}
type: Opaque
${stringData}`;
}

/** ServiceAccount + ClusterRole + ClusterRoleBinding + namespaced Role/RoleBinding. */
export function rbac(ns: string): string {
  return `apiVersion: v1
kind: ServiceAccount
metadata:
  name: rigel-assistant
  namespace: ${ns}
  labels:
    app.kubernetes.io/managed-by: rigel-assistant
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: rigel-assistant
  labels:
    app.kubernetes.io/managed-by: rigel-assistant
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
  name: rigel-assistant
  labels:
    app.kubernetes.io/managed-by: rigel-assistant
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: rigel-assistant
subjects:
  - kind: ServiceAccount
    name: rigel-assistant
    namespace: ${ns}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: rigel-assistant-state
  namespace: ${ns}
  labels:
    app.kubernetes.io/managed-by: rigel-assistant
rules:
  - apiGroups: [""]
    resources: [configmaps]
    resourceNames: [assistant-config, assistant-state, assistant-backups]
    verbs: [get, update, patch]
  - apiGroups: [""]
    resources: [configmaps]
    verbs: [create, delete]
  - apiGroups: ["batch"]
    resources: [jobs]
    verbs: [create, delete, get, list, watch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: rigel-assistant-state
  namespace: ${ns}
  labels:
    app.kubernetes.io/managed-by: rigel-assistant
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: rigel-assistant-state
subjects:
  - kind: ServiceAccount
    name: rigel-assistant
    namespace: ${ns}
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: rigel-fix-runner
  namespace: ${ns}
  labels:
    app.kubernetes.io/name: rigel-fix-runner
    app.kubernetes.io/managed-by: rigel-assistant
automountServiceAccountToken: false`;
}

/** The three pre-created ConfigMaps: config (control surface, seeded with the
 *  role selections + operational limits), state, backups. */
export function configMaps(c: AssistantInstallConfig): string {
  const ns = c.installNamespace;
  // Seed role keys (default to claude worker=sonnet / supervisor=opus to match
  // the WORKER_MODEL/SUPERVISOR_MODEL env fallbacks + parseRoleSelection defaults).
  const worker = c.worker ?? { provider: "claude", model: c.workerModel };
  const supervisor = c.supervisor ?? { provider: "claude", model: c.supervisorModel };
  const roleLines = [
    `  workerProvider: ${worker.provider}`,
    `  workerModel: ${worker.model}`,
    ...(worker.effort ? [`  workerEffort: ${worker.effort}`] : []),
    `  supervisorProvider: ${supervisor.provider}`,
    `  supervisorModel: ${supervisor.model}`,
    ...(supervisor.effort ? [`  supervisorEffort: ${supervisor.effort}`] : []),
  ].join("\n");
  const nsList = c.namespaces
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
  const limitLines = [
    `  pollIntervalMs: "${c.pollIntervalMs}"`,
    `  maxPerResourcePerHour: "${c.maxPerResourcePerHour}"`,
    `  maxPerNight: "${c.maxPerNight}"`,
    `  maxAttemptsPerIncident: "${c.maxAttemptsPerIncident}"`,
    `  confirmPolls: "${c.confirmPolls}"`,
    `  namespaces: "${nsList}"`,
  ].join("\n");
  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: assistant-config
  namespace: ${ns}
  labels:
    app.kubernetes.io/managed-by: rigel-assistant
data:
  enabled: "true"
  mode: "auto"
${roleLines}
${limitLines}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: assistant-state
  namespace: ${ns}
  labels:
    app.kubernetes.io/managed-by: rigel-assistant
data: {}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: assistant-backups
  namespace: ${ns}
  labels:
    app.kubernetes.io/managed-by: rigel-assistant
data: {}`;
}

/**
 * Render the 7 credential env blocks (12-space indented, matching the Deployment
 * template), each as a `secretKeyRef` resolved from `sources[id]` when present,
 * else CREDENTIAL_ENV's default managed Secret + key. Every ref is `optional:
 * true` so a missing credential never blocks startup. Pure — never reads a value.
 */
export function credentialEnvYAML(
  sources: Partial<Record<keyof AssistantCredentials, ResolvedSource>> = {},
): string {
  // Explanatory comment kept between the legacy Claude token env and the
  // provider-key block, exactly where it sat before this was extracted.
  const PROVIDER_KEYS_COMMENT =
    "            # Provider API keys from the multi-key credentials Secret. Each is\n" +
    "            # optional so a missing credential never blocks startup; the matching\n" +
    "            # bridge fails closed at run time if its role's provider has no key.";
  return CREDENTIAL_ENV.map((entry, i) => {
    const src = sources[entry.id];
    const name = src?.secretName ?? entry.defaultSecret;
    const key = src?.dataKey ?? entry.defaultKey;
    const block = `            - name: ${entry.env}
              valueFrom:
                secretKeyRef:
                  name: ${name}
                  key: ${key}
                  optional: true`;
    // claudeToken is first; the comment precedes the remaining provider keys.
    return i === 1 ? `${PROVIDER_KEYS_COMMENT}\n${block}` : block;
  }).join("\n");
}

/**
 * Strategic-merge patch that repoints ONE credential's env var at `source`,
 * leaving the image, models, and every other env untouched (env merges by
 * `name`). Used to apply a BYO source change without re-rendering — and so
 * reverting a credential never resets unrelated Deployment config. The patch
 * mutates the pod template, which triggers a rollout on its own.
 *
 * Pass the resolved managed default (CREDENTIAL_ENV) to revert a credential.
 * `"agent"` is the container name in `deployment()` above.
 */
export function credentialEnvPatch(
  credentialId: keyof AssistantCredentials,
  source: { secretName: string; dataKey: string },
): string {
  const entry = CREDENTIAL_ENV.find((e) => e.id === credentialId);
  if (!entry) throw new Error(`unknown credential id: ${credentialId}`);
  return JSON.stringify({
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: "agent",
              env: [
                {
                  name: entry.env,
                  valueFrom: { secretKeyRef: { name: source.secretName, key: source.dataKey, optional: true } },
                },
              ],
            },
          ],
        },
      },
    },
  });
}

/** The managed default source (Secret + key) for a credential id, used to revert
 *  a BYO repoint. */
export function defaultCredentialSource(
  credentialId: keyof AssistantCredentials,
): { secretName: string; dataKey: string } {
  const entry = CREDENTIAL_ENV.find((e) => e.id === credentialId);
  if (!entry) throw new Error(`unknown credential id: ${credentialId}`);
  return { secretName: entry.defaultSecret, dataKey: entry.defaultKey };
}

/** The agent Deployment (replicas:1, Recreate, RBAC cage, env from config).
 *  `sources` repoints credential env at operator-supplied Secrets; the default
 *  ({}) renders today's managed-Secret refs byte-for-byte. */
export function deployment(
  c: AssistantInstallConfig,
  sources: Partial<Record<keyof AssistantCredentials, ResolvedSource>> = {},
): string {
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: rigel-assistant
  namespace: ${c.installNamespace}
  labels:
    app.kubernetes.io/name: rigel-assistant
    app.kubernetes.io/managed-by: rigel-assistant
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app.kubernetes.io/name: rigel-assistant
  template:
    metadata:
      labels:
        app.kubernetes.io/name: rigel-assistant
    spec:
      serviceAccountName: rigel-assistant
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
${credentialEnvYAML(sources)}
            - name: WORKER_MODEL
              value: "${c.workerModel}"
            - name: SUPERVISOR_MODEL
              value: "${c.supervisorModel}"
            - name: POLL_INTERVAL_MS
              value: "${c.pollIntervalMs}"
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
            # The one-shot fix-runner Job runs the SAME image as the agent so an
            # approved fix PR is opened by the exact reviewed code (CI pins the
            # immutable per-sha tag via kubectl set image — see agent-build.yml).
            - name: RIGEL_FIX_RUNNER_IMAGE
              value: "${c.image}"
            # State/config/backups live in the install namespace (that's where
            # the RBAC Role and the pre-created ConfigMaps are, and where the web
            # panel reads them). Without this the agent defaults to "default" and,
            # when installed elsewhere, can never write its state — leaving the
            # panel stuck on "Setting up the assistant…".
            - name: STATE_NAMESPACE
              value: "${c.installNamespace}"
            - name: MATRIX_ACCESS_TOKEN
              valueFrom:
                secretKeyRef:
                  name: rigel-matrix-token
                  key: accessToken
                  optional: true
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
  return [rbac(c.installNamespace), configMaps(c), deployment(c)].join("\n---\n");
}

/**
 * Replace the token line in a Secret YAML with `***SECRET***` for preview. The
 * panel never previews the Secret YAML at all (it shows only manifestYAML), but
 * this guards any path that might render a token-bearing string.
 */
export function maskToken(yaml: string): string {
  // Line-anchored so it redacts the stringData `token:` value only, never an
  // annotation line like `rigel.assistant/credential.claudeToken: "token"`.
  return yaml.replace(/^(\s*token:\s*)"(?:[^"\\]|\\.)*"/gm, '$1"***SECRET***"');
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

/**
 * Per-subscription digest send-state, surfaced from the agent-owned `state.json`
 * for the web panel (last-sent timestamp + last preview text). Incident history
 * stays agent-internal and is never decoded here.
 */
export interface AssistantDigestState {
  lastSentAt: Record<string, string>;
  lastRunNowToken?: string;
  lastPreview?: { id: string; at: string; text: string };
}

/**
 * A fix PR the agent opened (or tried to), surfaced from the agent-owned
 * `state.json` (mirrors agent/src/state.ts `PullRequestRecord`). The agent only
 * emits `open`/`failed` today; the UI renders `merged` defensively too (the wire
 * is an untyped string), so it can show a merged PR if one is ever recorded.
 */
export interface AssistantPullRequest {
  at: string;
  fingerprint: string;
  filePath: string;
  incident: string;
  /** The workload / GitOps slug the PR is for. */
  app: string;
  /** The repo URL the PR was opened against. */
  repo: string;
  branch?: string;
  prUrl?: string;
  title: string;
  summary: string;
  status: "open" | "merged" | "failed";
  kind: string;
}

export interface AssistantClusterState {
  updatedAt?: string;
  status?: AssistantAgentStatus;
  audit: AssistantAuditEntry[];
  queue: AssistantQueuedSuggestion[];
  report: string;
  /** Fix PRs the agent opened (or tried to). Empty when absent. */
  pullRequests: AssistantPullRequest[];
  /** Scheduled-digest send-state (last-sent + last preview). Absent when no digests fired. */
  digestState?: AssistantDigestState;
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
  const rawDigestState = o.digestState && typeof o.digestState === "object"
    ? (o.digestState as Record<string, unknown>) : null;
  const digestState = rawDigestState
    ? {
        lastSentAt: (rawDigestState.lastSentAt && typeof rawDigestState.lastSentAt === "object")
          ? rawDigestState.lastSentAt as Record<string, string> : {},
        lastRunNowToken: typeof rawDigestState.lastRunNowToken === "string"
          ? rawDigestState.lastRunNowToken : undefined,
        lastPreview: (rawDigestState.lastPreview && typeof rawDigestState.lastPreview === "object")
          ? rawDigestState.lastPreview as { id: string; at: string; text: string } : undefined,
      }
    : undefined;
  return {
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : undefined,
    status: (o.status as AssistantAgentStatus | undefined) ?? undefined,
    audit: Array.isArray(o.audit) ? (o.audit as AssistantAuditEntry[]) : [],
    queue: Array.isArray(o.queue) ? (o.queue as AssistantQueuedSuggestion[]) : [],
    report: typeof o.report === "string" ? o.report : "",
    pullRequests: Array.isArray(o.pullRequests) ? (o.pullRequests as AssistantPullRequest[]) : [],
    digestState,
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
// assistant-config key builders (used by install seed + setModels + setLimits)
// ---------------------------------------------------------------------------

/** One role's selection as the server receives it (provider id is a plain string;
 * the agent re-validates it against its provider set, so no enum needed here). */
export interface RoleSelectionInput {
  provider: string;
  model: string;
  /** Claude-family reasoning effort; omitted for other providers. */
  effort?: string;
}

/** The operational limits a user can change live (subset can be provided). */
export interface LimitsInput {
  pollIntervalMs?: number;
  maxPerResourcePerHour?: number;
  maxPerNight?: number;
  maxAttemptsPerIncident?: number;
  confirmPolls?: number;
  /** Monitored namespaces; empty array = all. */
  namespaces?: string[];
}

/**
 * The autofix (agent-opened fix PRs) control surface a user can change live: the
 * master opt-in, the rolling-24h cap, and the scope it applies to. Any subset can
 * be provided. Scope is a list of project ids ONLY; a project id is
 * `"<namespace>/<deployment>"`. (A namespace holds deployments from many repos,
 * so opting in a whole namespace is never one-to-one.)
 */
export interface AutofixInput {
  enabled?: boolean;
  /** Rolling-24h cap on agent-opened fix PRs. */
  maxPerDay?: number;
  scope?: { projects?: string[] };
}

/** Trim, drop empties, and dedupe a scope list (stable first-seen order). */
function cleanScopeList(v: string[] | undefined): string[] {
  if (!v) return [];
  const out: string[] = [];
  for (const raw of v) {
    const s = (raw ?? "").trim();
    if (s !== "" && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Build the assistant-config updates for the autofix control surface, using the
 * EXACT keys + encodings `agent/src/runtimeConfig.ts` (parseAutofixConfig /
 * parseAutofixScope / parseAutofixMaxPerDay) reads:
 *   autofixEnabled   — "true" | "false" (the agent treats only "true" as enabled)
 *   autofixMaxPerDay — a non-negative integer, stringified (clamped + floored)
 *   autofixScope     — JSON.stringify({ projects }) (trimmed, deduped)
 * Only provided fields are emitted, so a partial update never clobbers the others
 * (toggling the opt-in leaves the scope + cap intact, like limitsConfigUpdates).
 * A non-finite maxPerDay is dropped (the agent fails safe to its default).
 */
export function autofixConfigUpdates(input: AutofixInput): Record<string, string> {
  const updates: Record<string, string> = {};
  if (input.enabled !== undefined) updates.autofixEnabled = input.enabled ? "true" : "false";
  if (input.maxPerDay !== undefined && Number.isFinite(input.maxPerDay)) {
    updates.autofixMaxPerDay = String(Math.max(0, Math.floor(input.maxPerDay)));
  }
  if (input.scope !== undefined) {
    updates.autofixScope = JSON.stringify({
      projects: cleanScopeList(input.scope.projects),
    });
  }
  return updates;
}

/**
 * Build the assistant-config updates for the per-role selections, using the EXACT
 * keys `agent/src/runtimeConfig.ts parseRoleSelection` reads. `effort` keys are
 * only emitted when set. A role omitted (undefined) contributes no keys, so a
 * worker-only change never touches the supervisor keys.
 */
export function roleConfigUpdates(
  worker?: RoleSelectionInput,
  supervisor?: RoleSelectionInput,
): Record<string, string> {
  const updates: Record<string, string> = {};
  if (worker) {
    updates.workerProvider = worker.provider;
    updates.workerModel = worker.model;
    if (worker.effort && worker.effort.trim() !== "") updates.workerEffort = worker.effort;
  }
  if (supervisor) {
    updates.supervisorProvider = supervisor.provider;
    updates.supervisorModel = supervisor.model;
    if (supervisor.effort && supervisor.effort.trim() !== "") updates.supervisorEffort = supervisor.effort;
  }
  return updates;
}

/**
 * Build the assistant-config updates for the operational limits, using the EXACT
 * keys `agent/src/runtimeConfig.ts parseLimits` reads. Numbers are stringified;
 * namespaces is newline-joined ("" = all namespaces). Only provided fields are
 * emitted, so a partial update never clobbers other limit keys.
 */
export function limitsConfigUpdates(limits: LimitsInput): Record<string, string> {
  const updates: Record<string, string> = {};
  if (limits.pollIntervalMs !== undefined) updates.pollIntervalMs = String(limits.pollIntervalMs);
  if (limits.maxPerResourcePerHour !== undefined) updates.maxPerResourcePerHour = String(limits.maxPerResourcePerHour);
  if (limits.maxPerNight !== undefined) updates.maxPerNight = String(limits.maxPerNight);
  if (limits.maxAttemptsPerIncident !== undefined) updates.maxAttemptsPerIncident = String(limits.maxAttemptsPerIncident);
  if (limits.confirmPolls !== undefined) updates.confirmPolls = String(limits.confirmPolls);
  if (limits.namespaces !== undefined) updates.namespaces = limits.namespaces.join("\n");
  return updates;
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
      labels: { "app.kubernetes.io/managed-by": "rigel-assistant" },
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
      labels: { "app.kubernetes.io/managed-by": "rigel-assistant" },
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
