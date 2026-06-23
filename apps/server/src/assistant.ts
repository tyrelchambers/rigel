// Assistant agent control plane — server side of docs/parity/assistant.md.
//
// POST /api/assistant dispatches on `action`:
//   install | uninstall | setMode | kill | updateToken | restart |
//   silence | unsilence | clearReport
//
// All cluster writes go through kubectl with an argv array (no shell). The
// OAuth token is ONLY ever placed in the applied Secret's stdin — it is never
// logged, echoed, or returned. ConfigMap edits use read-modify-write so a
// single setting change never clobbers concurrent edits (kill-switch vs mode
// vs silenced…), exactly like the Swift `patchConfig`.

import { buildKubectlArgs, kubectl, runProcessWithStdin, type RunResult } from "@rigel/k8s/src/run";
import {
  DEFAULT_INSTALL_CONFIG,
  SECRET_NAME,
  CREDENTIALS_SECRET_NAME,
  namespaceYAML,
  secretYAML,
  credentialsSecretYAML,
  manifestYAML,
  mergedConfigMapJSON,
  clearedReportConfigMapJSON,
  clearedStateConfigMapJSON,
  silencedSet,
  roleConfigUpdates,
  limitsConfigUpdates,
  type AssistantInstallConfig,
  type AssistantCredentials,
  type RoleSelectionInput,
  type LimitsInput,
} from "@rigel/k8s/src/assistant";
import { signalConfigUpdates } from "@rigel/k8s/src/signal";
import { normalizeAlertRule, parseAlertRules, serializeAlertRules, nextAlertRules, type SuggestedAlert } from "@rigel/k8s";
import { effectiveClaudeToken } from "./chatConfig";

// ---------------------------------------------------------------------------
// kubectl plumbing
// ---------------------------------------------------------------------------

/**
 * Run `kubectl [--context ctx] <args>`, feeding `stdin` (when given) on the
 * process stdin pipe — NEVER interpolated into a shell. Returns { code, stdout,
 * stderr }; code -1 when the kubectl binary is missing.
 */
export async function runKubectlStdin(
  context: string | null,
  args: string[],
  stdin: string | null,
): Promise<RunResult> {
  const full = buildKubectlArgs(context, args);
  // An empty closed stdin is harmless for the commands that pass `null` here
  // (get/rollout/delete don't read stdin); apply/delete -f - get the real YAML.
  return runProcessWithStdin("kubectl", full, stdin ?? "");
}

/** Throw with the kubectl stderr when a step failed (non-zero exit). */
function ensureOk(result: RunResult, label: string): void {
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new Error(`${label}: ${detail}`);
  }
}

const applyStdin = (ctx: string | null, yaml: string) =>
  runKubectlStdin(ctx, ["apply", "-f", "-"], yaml);
const deleteStdin = (ctx: string | null, yaml: string) =>
  runKubectlStdin(ctx, ["delete", "-f", "-", "--ignore-not-found=true"], yaml);

/** Read the named ConfigMap's `data` map, or {} when absent/unparseable. */
async function readConfigMapData(
  context: string | null,
  namespace: string,
  name: string,
): Promise<Record<string, string>> {
  const res = await kubectl(context, ["get", "cm", name, "-n", namespace, "-o", "json"]);
  if (res.code !== 0) return {};
  try {
    const obj = JSON.parse(res.stdout) as { data?: Record<string, string> };
    return obj.data ?? {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Request types
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
  | "restart"
  | "silence"
  | "unsilence"
  | "clearReport"
  | "clearActivity"
  | "setSignal"
  | "saveAlert" | "deleteAlert" | "toggleAlert"
  | "credentialStatus";

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
  // Multi-provider control plane (Plan 2).
  worker?: RoleSelectionInput;
  supervisor?: RoleSelectionInput;
  credentials?: AssistantCredentials;
  limits?: LimitsInput;
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
  // alert rules (saveAlert/deleteAlert/toggleAlert)
  alert?: SuggestedAlert;   // saveAlert payload (model block, validated server-side)
  alertId?: string;          // delete/toggle
  alertEnabled?: boolean;    // toggle
}

// ---------------------------------------------------------------------------
// Validation (mirrors Swift install() guards)
// ---------------------------------------------------------------------------

export function validateInstall(namespace: string, token: string, image: string): void {
  if (token.trim() === "") {
    throw new Error("Paste the token from `claude setup-token` first.");
  }
  const img = image.trim();
  if (img === "") throw new Error("Set a container image first.");
  const repoPath = img.split(":")[0] ?? img;
  if (repoPath !== repoPath.toLowerCase()) {
    throw new Error(
      "Image repository must be lowercase (Kubernetes rejects uppercase as InvalidImageName).",
    );
  }
  const ns = namespace.trim();
  if (ns === "") throw new Error("Set an install namespace (e.g. default).");
  if (ns !== ns.toLowerCase()) throw new Error("Namespace must be lowercase.");
}

/** Credential key names the agent understands (match the bridges' authEnv()). */
const KNOWN_CREDENTIAL_KEYS: readonly string[] = [
  "claudeToken", "anthropicApiKey", "codexApiKey", "geminiApiKey",
  "opencodeApiKey", "opencodeAuthContent",
];

/** Map the present Secret key NAMES (from the credentials Secret + the legacy token
 *  Secret) to the normalized credential vocabulary the UI consumes. The legacy `token`
 *  key counts as `claudeToken`; unknown keys are dropped. Handles NAMES only — never
 *  secret values. */
export function normalizeCredentialKeys(credsKeys: string[], legacyKeys: string[]): string[] {
  const present = new Set<string>();
  for (const k of credsKeys) if (KNOWN_CREDENTIAL_KEYS.includes(k)) present.add(k);
  if (legacyKeys.includes("token")) present.add("claudeToken");
  return [...present];
}

/**
 * Extract the credentials map from a request: take req.credentials, drop any
 * empty/whitespace value, and fold a legacy top-level `token` into `claudeToken`
 * (so old callers still work). Pure — testable without a cluster.
 */
export function parseCredentials(req: AssistantRequest): AssistantCredentials {
  const out: AssistantCredentials = {};
  const src = req.credentials ?? {};
  for (const [k, v] of Object.entries(src) as [keyof AssistantCredentials, string | undefined][]) {
    if (typeof v === "string" && v.trim() !== "") out[k] = v.trim();
  }
  if (!out.claudeToken && req.token && req.token.trim() !== "") {
    out.claudeToken = req.token.trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

/**
 * Build the AssistantInstallConfig from a request. The per-role selections seed
 * the assistant-config ConfigMap (via packages/k8s configMaps); the legacy
 * workerModel/supervisorModel knobs remain the env fallback. Limits map onto the
 * install knobs (namespaces is comma-joined for the env/ConfigMap). Pure.
 */
export function buildInstallConfig(req: AssistantRequest): AssistantInstallConfig {
  const namespace = (req.namespace ?? DEFAULT_INSTALL_CONFIG.installNamespace).trim() || DEFAULT_INSTALL_CONFIG.installNamespace;
  const image = (req.image ?? DEFAULT_INSTALL_CONFIG.image).trim() || DEFAULT_INSTALL_CONFIG.image;
  const limits = req.limits ?? {};
  const monitorNamespaces =
    limits.namespaces !== undefined ? limits.namespaces.join(",") : req.monitorNamespaces ?? DEFAULT_INSTALL_CONFIG.namespaces;
  return {
    image,
    installNamespace: namespace,
    namespaces: monitorNamespaces,
    workerModel: req.worker?.model ?? req.workerModel ?? DEFAULT_INSTALL_CONFIG.workerModel,
    supervisorModel: req.supervisor?.model ?? req.supervisorModel ?? DEFAULT_INSTALL_CONFIG.supervisorModel,
    pollIntervalMs: limits.pollIntervalMs ?? req.pollIntervalMs ?? DEFAULT_INSTALL_CONFIG.pollIntervalMs,
    maxPerResourcePerHour: limits.maxPerResourcePerHour ?? req.maxPerResourcePerHour ?? DEFAULT_INSTALL_CONFIG.maxPerResourcePerHour,
    maxPerNight: limits.maxPerNight ?? req.maxPerNight ?? DEFAULT_INSTALL_CONFIG.maxPerNight,
    maxAttemptsPerIncident: limits.maxAttemptsPerIncident ?? req.maxAttemptsPerIncident ?? DEFAULT_INSTALL_CONFIG.maxAttemptsPerIncident,
    confirmPolls: limits.confirmPolls ?? req.confirmPolls ?? DEFAULT_INSTALL_CONFIG.confirmPolls,
    worker: req.worker,
    supervisor: req.supervisor,
  };
}

/** Pure: the assistant-config role-key updates for a setModels request. */
export function setModelsUpdates(req: AssistantRequest): Record<string, string> {
  return roleConfigUpdates(req.worker, req.supervisor);
}

/** Pure: the Secret YAML(s) a setCredentials request applies. Always the
 *  credentials Secret; additionally the legacy token Secret (re-stamped) when a
 *  Claude OAuth token is supplied, so existing CLAUDE_CODE_OAUTH_TOKEN refs refresh. */
export function setCredentialsSecrets(
  req: AssistantRequest,
  namespace: string,
  now: Date,
): { credentialsYaml: string; legacyTokenYaml: string | null } {
  const creds = parseCredentials(req);
  const credentialsYaml = credentialsSecretYAML(creds, namespace);
  const legacyTokenYaml = creds.claudeToken
    ? secretYAML(creds.claudeToken, now.toISOString(), namespace)
    : null;
  return { credentialsYaml, legacyTokenYaml };
}

/**
 * Apply, in order: the namespace (best-effort — kubectl apply is idempotent and
 * creates it when missing), the token Secret (with a fresh issued-at stamp), and
 * the RBAC + ConfigMaps + Deployment manifests. The Secret goes first so a bad
 * token can be rolled back without reapplying RBAC.
 */
async function installAssistant(
  context: string | null,
  req: AssistantRequest,
): Promise<RunResult> {
  const config = buildInstallConfig(req);
  const namespace = config.installNamespace;

  // Credentials: req.credentials (+ legacy top-level token folded into claudeToken).
  // For Claude we still also accept the user's already-saved token (onboarding /
  // Settings) so they don't re-enter it.
  const creds = parseCredentials(req);
  if (!creds.claudeToken) {
    const saved = (await effectiveClaudeToken()) ?? "";
    if (saved.trim() !== "") creds.claudeToken = saved.trim();
  }

  // Validate: at least one credential must be present (the worker can't run with
  // none). Keep the legacy Claude validation when a Claude token is the only cred.
  const hasAnyCred = Object.values(creds).some((v) => typeof v === "string" && v.trim() !== "");
  validateInstall(namespace, hasAnyCred ? "ok" : "", config.image);

  // 1. Namespace (idempotent; creates it when missing).
  ensureOk(await applyStdin(context, namespaceYAML(namespace)), `Failed to create namespace ${namespace}`);

  // 2. Legacy token Secret first (only when a Claude OAuth token is present) so a
  //    bad token can be rolled back without reapplying RBAC, and existing installs
  //    that read CLAUDE_CODE_OAUTH_TOKEN from this Secret keep working.
  if (creds.claudeToken) {
    const issuedAt = new Date().toISOString();
    ensureOk(await applyStdin(context, secretYAML(creds.claudeToken, issuedAt, namespace)), "Failed to create token Secret");
  }

  // 3. Multi-key credentials Secret (the other providers + an Anthropic API key).
  ensureOk(await applyStdin(context, credentialsSecretYAML(creds, namespace)), "Failed to create credentials Secret");

  // 4. RBAC + ConfigMaps (seeded with role + limit keys) + Deployment.
  const result = await applyStdin(context, manifestYAML(config));
  ensureOk(result, "Failed to apply manifests");
  return result;
}

/** Delete the manifests, then both Secrets (legacy token + provider credentials —
 *  the latter carries API keys, so don't leave it orphaned). Leaves the namespace
 *  + audit history. */
async function uninstallAssistant(context: string | null, namespace: string): Promise<RunResult> {
  const config: AssistantInstallConfig = { ...DEFAULT_INSTALL_CONFIG, installNamespace: namespace };
  ensureOk(await deleteStdin(context, manifestYAML(config)), "Uninstall failed");
  return runKubectlStdin(
    context,
    ["delete", "secret", SECRET_NAME, CREDENTIALS_SECRET_NAME, "-n", namespace, "--ignore-not-found=true"],
    null,
  );
}

/** Read-modify-write `assistant-config`, merging `updates`. */
async function patchConfig(
  context: string | null,
  namespace: string,
  updates: Record<string, string>,
): Promise<RunResult> {
  const existing = await readConfigMapData(context, namespace, "assistant-config");
  const cmJSON = mergedConfigMapJSON(namespace, existing, updates);
  const result = await applyStdin(context, cmJSON);
  ensureOk(result, "Failed to update config");
  return result;
}

/**
 * Read-modify-write `assistant-config` with the Signal notification settings.
 * Only the provided fields are written, so a recipients edit never drops the
 * two-way toggle and vice versa (mirrors Swift `setSignal`).
 */
async function setSignal(
  context: string | null,
  namespace: string,
  req: AssistantRequest,
): Promise<RunResult> {
  const updates = signalConfigUpdates({
    apiUrl: req.apiUrl,
    number: req.number,
    recipients: req.recipients,
    inbound: req.inbound,
  });
  return patchConfig(context, namespace, updates);
}

/** Read-modify-write the `alertRules` key of `assistant-config`. */
async function mutateAlerts(
  context: string | null,
  namespace: string,
  req: AssistantRequest,
): Promise<RunResult> {
  const existing = await readConfigMapData(context, namespace, "assistant-config");
  const rules = parseAlertRules(existing["alertRules"]);
  let next;
  if (req.action === "saveAlert") {
    if (!req.alert) throw new Error("saveAlert requires an `alert` payload.");
    const rule = normalizeAlertRule(req.alert, crypto.randomUUID(), Date.now());
    next = nextAlertRules(rules, { op: "add", rule });
  } else if (req.action === "deleteAlert") {
    if (!req.alertId) throw new Error("deleteAlert requires `alertId`.");
    next = nextAlertRules(rules, { op: "delete", id: req.alertId });
  } else {
    if (!req.alertId) throw new Error("toggleAlert requires `alertId`.");
    next = nextAlertRules(rules, { op: "toggle", id: req.alertId, enabled: req.alertEnabled === true });
  }
  return patchConfig(context, namespace, { alertRules: serializeAlertRules(next) });
}

/** Pure: the assistant-config limit-key updates for a setLimits request. */
export function setLimitsUpdates(req: AssistantRequest): Record<string, string> {
  return limitsConfigUpdates(req.limits ?? {});
}

/** Live limit change: read-modify-write the limit keys in assistant-config. No
 *  restart — the agent reads rc.limits each tick. */
async function setLimits(
  context: string | null,
  namespace: string,
  req: AssistantRequest,
): Promise<RunResult> {
  const updates = setLimitsUpdates(req);
  if (Object.keys(updates).length === 0) {
    throw new Error("setLimits requires at least one limit field.");
  }
  return patchConfig(context, namespace, updates);
}

/** Live role switch: read-modify-write the role keys in assistant-config. No
 *  restart — the agent re-reads the ConfigMap every poll. */
async function setModels(
  context: string | null,
  namespace: string,
  req: AssistantRequest,
): Promise<RunResult> {
  const updates = setModelsUpdates(req);
  if (Object.keys(updates).length === 0) {
    throw new Error("setModels requires a worker and/or supervisor selection.");
  }
  return patchConfig(context, namespace, updates);
}

/** Re-apply the credentials Secret (+ legacy token Secret when a Claude token is
 *  supplied), then rollout-restart so the new env vars are injected. Generalizes
 *  the old token-only updateToken. */
async function setCredentials(
  context: string | null,
  namespace: string,
  req: AssistantRequest,
): Promise<RunResult> {
  const creds = parseCredentials(req);
  if (Object.values(creds).every((v) => !v || v.trim() === "")) {
    throw new Error("setCredentials requires at least one credential.");
  }
  const { credentialsYaml, legacyTokenYaml } = setCredentialsSecrets(req, namespace, new Date());
  if (legacyTokenYaml) {
    ensureOk(await applyStdin(context, legacyTokenYaml), "Failed to update token Secret");
  }
  ensureOk(await applyStdin(context, credentialsYaml), "Failed to update credentials Secret");
  const result = await restartAgent(context, namespace);
  ensureOk(result, "Credentials saved, but rollout failed");
  return result;
}

async function setMode(
  context: string | null,
  namespace: string,
  mode: string,
  window: string,
): Promise<RunResult> {
  return patchConfig(context, namespace, { mode, window: window.trim() });
}

async function setKillSwitch(
  context: string | null,
  namespace: string,
  enabled: boolean,
): Promise<RunResult> {
  return patchConfig(context, namespace, { enabled: enabled ? "true" : "false" });
}

async function silenceIncident(
  context: string | null,
  namespace: string,
  fingerprint: string,
  add: boolean,
): Promise<RunResult> {
  const existing = await readConfigMapData(context, namespace, "assistant-config");
  const s = silencedSet(existing);
  if (add) s.add(fingerprint);
  else s.delete(fingerprint);
  return patchConfig(context, namespace, {
    silenced: [...s].sort().join("\n"),
  });
}

/** Backward-compat alias: an old token-only update routes through setCredentials
 *  (which re-stamps the legacy token Secret + the credentials Secret, then rolls). */
async function updateToken(
  context: string | null,
  namespace: string,
  token: string,
): Promise<RunResult> {
  if (token.trim() === "") {
    throw new Error("Paste a fresh token from `claude setup-token` first.");
  }
  return setCredentials(context, namespace, { action: "setCredentials", token: token.trim() });
}

function restartAgent(context: string | null, namespace: string): Promise<RunResult> {
  return runKubectlStdin(
    context,
    ["rollout", "restart", "deployment/rigel-assistant", "-n", namespace],
    null,
  );
}

/** Read-modify-write `assistant-state`, clearing only the `report` field. */
async function clearReport(context: string | null, namespace: string): Promise<RunResult> {
  const data = await readConfigMapData(context, namespace, "assistant-state");
  const cmJSON = clearedReportConfigMapJSON(namespace, data["state.json"]);
  // Nothing to clear (no state yet) is a no-op success.
  if (cmJSON == null) return { code: 0, stdout: "", stderr: "" };
  const result = await applyStdin(context, cmJSON);
  ensureOk(result, "Failed to clear report");
  return result;
}

/** Read-modify-write `assistant-state`, emptying the `audit` history array. */
async function clearActivity(context: string | null, namespace: string): Promise<RunResult> {
  const data = await readConfigMapData(context, namespace, "assistant-state");
  const cmJSON = clearedStateConfigMapJSON(namespace, data["state.json"], { audit: [] });
  // Nothing to clear (no state yet) is a no-op success.
  if (cmJSON == null) return { code: 0, stdout: "", stderr: "" };
  const result = await applyStdin(context, cmJSON);
  ensureOk(result, "Failed to clear activity");
  return result;
}

/** Report which credential key NAMES exist (never the values) across the credentials
 *  Secret + the legacy token Secret, for the UI's readiness chips. */
async function credentialStatus(context: string | null, namespace: string): Promise<RunResult> {
  const keysOf = async (secret: string): Promise<string[]> => {
    const res = await kubectl(context, ["get", "secret", secret, "-n", namespace, "-o", "json"]);
    if (res.code !== 0) return []; // not found / no access → no keys
    try {
      const obj = JSON.parse(res.stdout) as { data?: Record<string, unknown> };
      return Object.keys(obj.data ?? {}); // key NAMES only — values discarded here
    } catch {
      return [];
    }
  };
  const [credsKeys, legacyKeys] = await Promise.all([
    keysOf(CREDENTIALS_SECRET_NAME),
    keysOf(SECRET_NAME),
  ]);
  return {
    code: 0,
    stdout: JSON.stringify({ credentialKeys: normalizeCredentialKeys(credsKeys, legacyKeys) }),
    stderr: "",
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Route a parsed assistant request to its handler. Returns the kubectl
 * RunResult for the final step. Throws on validation/kubectl failure (the
 * caller maps that to a 4xx/5xx WITHOUT the token).
 */
export async function handleAssistant(
  context: string | null,
  req: AssistantRequest,
): Promise<RunResult> {
  const namespace = (req.namespace ?? "default").trim() || "default";
  switch (req.action) {
    case "install":
      return installAssistant(context, req);
    case "uninstall":
      return uninstallAssistant(context, namespace);
    case "setMode":
      return setMode(context, namespace, req.mode ?? "auto", req.window ?? "");
    case "kill":
      return setKillSwitch(context, namespace, req.enabled === true);
    case "updateToken":
      return updateToken(context, namespace, req.token ?? "");
    case "setModels":
      return setModels(context, namespace, req);
    case "setCredentials":
      return setCredentials(context, namespace, req);
    case "setLimits":
      return setLimits(context, namespace, req);
    case "restart":
      return restartAgent(context, namespace);
    case "silence":
      return silenceIncident(context, namespace, req.fingerprint ?? "", true);
    case "unsilence":
      return silenceIncident(context, namespace, req.fingerprint ?? "", false);
    case "clearReport":
      return clearReport(context, namespace);
    case "clearActivity":
      return clearActivity(context, namespace);
    case "setSignal":
      return setSignal(context, namespace, req);
    case "saveAlert":
    case "deleteAlert":
    case "toggleAlert":
      return mutateAlerts(context, namespace, req);
    case "credentialStatus":
      return credentialStatus(context, namespace);
    default:
      throw new Error(`unknown action: ${String(req.action)}`);
  }
}
