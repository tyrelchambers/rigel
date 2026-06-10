# Assistant Panel — Web Port Specification

## Overview

The Assistant panel controls an in-cluster agent Deployment (`helmsman-assistant`) that watches the cluster and auto-fixes safe issues. The web port must preserve the exact install flow, kill-switch mechanism, autonomy modes, and status derivation from the Swift app.

## Kubernetes Objects Deployed

The installer (`POST /api/assistant {action:'install', namespace, token, image?, mode?}`) applies these resources as multi-doc YAML:

### ServiceAccount + ClusterRole + ClusterRoleBinding (RBAC cage)

**ServiceAccount**: `helmsman-assistant` in `{installNamespace}`
- Scoped identity for the agent pod.

**ClusterRole**: `helmsman-assistant`
- **Read** (no secrets): pods, logs, nodes, events, namespaces, services, endpoints, PVCs, PVs, configmaps, deployments, replicasets, statefulsets, daemonsets, jobs, cronjobs, metrics (pods/nodes).
- **Write** (narrow mutations only):
  - `deployments` [patch, update] — restart, setEnv, rollback
  - `deployments/scale` [patch, update] — scale
  - `pods` [delete] — delete crashlooping pods (controller recreates)
  - `nodes` [patch] — cordon/uncordon (set spec.unschedulable)
- **Invariant**: NO access to `secrets`, namespaces delete, PVC/PV delete, pod create, or RBAC verbs.

**ClusterRoleBinding**: `helmsman-assistant`
- Binds ClusterRole to the ServiceAccount.

### Namespaced Role + RoleBinding (config state access)

**Role**: `helmsman-assistant-state` in `{installNamespace}`
- Scoped to three ConfigMaps (by resourceNames): `assistant-config`, `assistant-state`, `assistant-backups`
- Verbs: [get, update, patch]
- Pre-created at install; no create verb (agent only reads/writes existing CMs).

**RoleBinding**: `helmsman-assistant-state` in `{installNamespace}`
- Binds Role to the ServiceAccount.

### ConfigMaps

**`assistant-config`** in `{installNamespace}`
- Runtime control surface: `enabled`, `mode`, `window`, `webhookUrl`, `signalApiUrl`, `signalNumber`, `signalRecipients`, `signalInbound`, `silenced` (newline-separated fingerprints).
- Agent reads every poll; Helmsman writes patches (never replaces full CM, to avoid clobbering concurrent edits).
- Defaults: `enabled: "true"`, `mode: "auto"`.

**`assistant-state`** in `{installNamespace}`
- Agent-owned status surface: single JSON key `state.json` (see AssistantClusterState struct below).
- Helmsman reads; agent writes. Pre-created empty.

**`assistant-backups`** in `{installNamespace}`
- Pre-mutation YAML snapshots (keyed by fingerprint); enables one-click revert.
- Pre-created empty. No deletion; capped by agent.

### Secret

**`assistant-claude-token`** in `{installNamespace}`
- Type: Opaque
- Key: `token` (the OAuth token string)
- Annotation: `helmsman.assistant/token-issued-at` — ISO-8601 timestamp at mint time (used to warn before 1-year expiry).
- Never shown in manifest preview; only visible in SecureField during install/update.
- Applied separately before the rest of the manifests (allows rollback of a bad token without reapplying RBAC).

### Deployment

**`helmsman-assistant`** in `{installNamespace}`
- Replicas: 1, Strategy: Recreate (single-writer of ConfigMaps).
- Pod labels: `app.kubernetes.io/name: helmsman-assistant` (used by Helmsman to locate the pod).
- ServiceAccount: `helmsman-assistant`.
- Image: `{image}` (from install form, e.g. `ghcr.io/tyrelchambers/helmsman-assistant:latest`).
- imagePullPolicy: IfNotPresent (or Always for :latest tag).
- Container name: `agent`.

**Env vars** (from config + hard-coded defaults):
- `CLAUDE_CODE_OAUTH_TOKEN` — from Secret
- `WORKER_MODEL` — default `claude-sonnet-4-6`
- `SUPERVISOR_MODEL` — default `claude-opus-4-8`
- `POLL_INTERVAL_MS` — default `30000`
- `SPEND_CAP_USD` — from install form (default 50)
- `MAX_PER_RESOURCE_PER_HOUR` — default 3
- `MAX_PER_NIGHT` — default 20
- `MAX_ATTEMPTS_PER_INCIDENT` — default 3
- `CONFIRM_POLLS` — default 2
- `NAMESPACES` — from install form (comma-separated; empty = all namespaces)

**Security**: runAsNonRoot=true, runAsUser/Group=1000, fsGroup=1000, seccompProfile=Unconfined (Bun GC issue), no privilege escalation, drop all caps, readOnlyRootFilesystem=false.

**Resources**: requests cpu=50m mem=128Mi, limits cpu=1 mem=512Mi.

---

## Template Placeholders

These must be substituted during install/uninstall/update:

- `{namespace}` — install target (e.g. "default", "assistant", or a new namespace created on demand).
- `{image}` — agent image (e.g. `ghcr.io/tyrelchambers/helmsman-assistant:latest`).
- `{token}` — Claude setup-token (escaped for YAML stringData, never logged).
- `{issuedAt}` — ISO-8601 string stamped at mint time (used for token expiry warning).
- `{spendCapUsd}` — int from form (e.g. 50).
- `{namespaces}` — comma-separated list or empty (e.g. "ns1,ns2" or "").
- `{workerModel}`, `{supervisorModel}` — LLM identifiers (defaults provided).
- `{pollIntervalMs}`, `{maxPerResourcePerHour}`, `{maxPerNight}`, `{maxAttemptsPerIncident}`, `{confirmPolls}` — tuning knobs (defaults provided).

---

## Autonomy Modes

All three modes are stored in `assistant-config` ConfigMap, key `mode`:

1. **Auto** (`mode: "auto"`)
   - Agent auto-fixes safe incidents immediately.
   - Suggested action appears in the audit timeline AFTER it's executed.

2. **Advisory** (`mode: "advisory"`)
   - Agent detects incidents but queues suggestions instead of acting.
   - Helmsman renders suggestions in the "Awaiting your approval" section.
   - User clicks the suggestion (routes through the confirm-sheet flow) to execute.
   - If not approved, the agent moves on (no persistent queue; next poll may re-suggest).

3. **Quiet-hours** (`mode: "window"`)
   - Agent auto-fixes INSIDE the window (e.g. `"22:00-07:00"`, agent's local time).
   - Outside the window, suggestions are queued (same as Advisory).
   - Window format: `"HH:MM-HH:MM"` (agent's timezone).
   - Stored in `assistant-config`, key `window`.

**Kill-switch** (instant pause):
- Stored in `assistant-config`, key `enabled` (string "true" or "false").
- Agent reads every poll (~30s default); setting to "false" halts all action within one interval.
- No scale-to-0 needed; the agent is always running but does nothing when disabled.

---

## Status Derivation

### Installed Check
- Query `kubectl get deployment helmsman-assistant --all-namespaces`.
- If found, `isInstalled = true` and `installedNamespace = metadata.namespace`.

### Health
- **Deployment status**: `status.replicas`, `status.readyReplicas`, `status.updatedReplicas`, `status.observedGeneration`.
- **Pod status** (from cache.pods filtered by label `app.kubernetes.io/name: helmsman-assistant`):
  - `pod.status.phase` (Running, Pending, Failed, etc.)
  - `pod.errorReason` (nil if healthy; set if ImagePullBackOff, CrashLoopBackOff, etc.).
  - `pod.status.containerStatuses[].restartCount`.
- Display summary: "Active" if Deployment ready, "Paused" if `enabled: "false"` in config, "Degraded" if pod is not Running or errorReason is set.

### Current Mode
- Read `assistant-config` ConfigMap, key `mode`.
- Default: "auto" if missing.

### Current Window
- Read `assistant-config` ConfigMap, key `window`.
- Only shown if `mode == "window"`.

### Token Expiry
- Lookup Secret `assistant-claude-token` in installed namespace.
- Read annotation `helmsman.assistant/token-issued-at` (ISO-8601 string).
- Parse and compute `daysRemaining = (issuedAt + 365 days - now) / 86400`.
- Status:
  - **ok**: daysRemaining > 30
  - **warning**: 0 < daysRemaining ≤ 30
  - **expired**: daysRemaining ≤ 0

### Agent State (audit, queue, report, status)
- Lookup ConfigMap `assistant-state` in installed namespace.
- Decode `data["state.json"]` as JSON:
  - `updatedAt` (ISO-8601 string, optional)
  - `status` (AssistantAgentStatus): `heartbeatAt`, `spentUsd`, `spendCapUsd`, `enabled`, `version`
  - `audit` (array of AssistantAuditEntry): `at`, `fingerprint`, `incident`, `proposal`, `command`, `tier`, `outcome`, `detail`, `backupRef`, `analysis`
  - `queue` (array of AssistantQueuedSuggestion): `at`, `incident`, `suggestion`, `reason`, `action` (SuggestedAction)
  - `report` (string, optional)
- All fields optional; default to empty arrays/nil.

### Live Issues (current cluster state, independent of agent)
- Iterate `kubectl get pods --all-namespaces`:
  - If `pod.errorReason` (computed from status.phase + containerStatus), append to liveIssues.
- Iterate `kubectl get deployments --all-namespaces`:
  - If `spec.replicas > 0 && status.readyReplicas < spec.replicas`, append degraded deployment.
- Fingerprint format: `"unhealthyPod|{ns}|{podName}|{reason}"` or `"degradedDeployment|{ns}|{deployName}|Degraded"`.

---

## User Actions & kubectl Commands

All mutations go through `/api/assistant` route (composing existing `/api/apply`, `/api/delete`, `/api/action` as needed).

### Install
**Route**: `POST /api/assistant`
**Payload**:
```json
{
  "action": "install",
  "namespace": "default",
  "token": "sk-...",
  "image": "ghcr.io/tyrelchambers/helmsman-assistant:latest",
  "spendCapUsd": 50,
  "workerModel": "claude-sonnet-4-6",
  "supervisorModel": "claude-opus-4-8",
  "pollIntervalMs": 30000,
  "maxPerResourcePerHour": 3,
  "maxPerNight": 20,
  "maxAttemptsPerIncident": 3,
  "confirmPolls": 2,
  "monitorNamespaces": "ns1,ns2"
}
```

**Steps**:
1. Create namespace if missing: `kubectl apply -f - <<< {namespaceYAML}`
2. Apply Secret (with issuedAt annotation): `kubectl apply -f - <<< {secretYAML}`
3. Apply manifests (RBAC + ConfigMaps + Deployment): `kubectl apply -f - <<< {manifestYAML}`

**Validation**:
- Token non-empty
- Image non-empty, repo lowercase
- Namespace non-empty, lowercase

### Uninstall
**Route**: `POST /api/assistant`
**Payload**:
```json
{
  "action": "uninstall",
  "namespace": "default"
}
```

**Steps**:
1. Delete manifests: `kubectl delete -f - --ignore-not-found=true <<< {manifestYAML}`
2. Delete Secret: `kubectl delete secret assistant-claude-token -n {namespace} --ignore-not-found=true`

**Note**: Leaves the namespace and audit history (ConfigMaps) in place.

### Set Autonomy Mode
**Route**: `POST /api/assistant`
**Payload**:
```json
{
  "action": "setMode",
  "namespace": "default",
  "mode": "auto",
  "window": ""
}
```

**Steps**:
- Read-modify-write `assistant-config` ConfigMap:
  1. `kubectl get cm assistant-config -n {namespace} -o json` (cache)
  2. Merge update: `data.mode = {mode}`, `data.window = {window}` (if mode == "window")
  3. `kubectl apply -f - <<< {updated-cm-json}`

**Modes**: "auto", "advisory", "window"
**Window format**: "HH:MM-HH:MM" or "" (empty clears it)

### Set Kill-Switch (Pause / Resume)
**Route**: `POST /api/assistant`
**Payload**:
```json
{
  "action": "kill",
  "namespace": "default",
  "enabled": false
}
```

**Steps**:
- Read-modify-write `assistant-config` ConfigMap:
  1. `kubectl get cm assistant-config -n {namespace} -o json` (cache)
  2. Merge update: `data.enabled = {enabled ? "true" : "false"}`
  3. `kubectl apply -f - <<< {updated-cm-json}`

**Label**: "Pause" if enabled, "Resume" if paused.
**Instant effect**: Agent checks on next poll (~30s).

### Update Token (after expiry or 401)
**Route**: `POST /api/assistant`
**Payload**:
```json
{
  "action": "updateToken",
  "namespace": "default",
  "token": "sk-..."
}
```

**Steps**:
1. Apply Secret (with fresh issuedAt): `kubectl apply -f - <<< {secretYAML}`
2. Roll Deployment: `kubectl rollout restart deployment/helmsman-assistant -n {namespace}`

### Restart Agent
**Route**: `POST /api/assistant`
**Payload**:
```json
{
  "action": "restart",
  "namespace": "default"
}
```

**Steps**:
- `kubectl rollout restart deployment/helmsman-assistant -n {namespace}`

### Silence Incident
**Route**: `POST /api/assistant`
**Payload**:
```json
{
  "action": "silence",
  "namespace": "default",
  "fingerprint": "unhealthyPod|default|mypod|CrashLoopBackOff"
}
```

**Steps**:
- Read-modify-write `assistant-config` ConfigMap:
  1. `kubectl get cm assistant-config -n {namespace} -o json`
  2. Merge silenced fingerprints: parse `data.silenced` (newline-separated), append, re-join, update
  3. `kubectl apply -f - <<< {updated-cm-json}`

### Unsilence Incident
**Route**: `POST /api/assistant`
**Payload**:
```json
{
  "action": "unsilence",
  "namespace": "default",
  "fingerprint": "unhealthyPod|default|mypod|CrashLoopBackOff"
}
```

**Steps**:
- Read-modify-write `assistant-config` ConfigMap (remove fingerprint from silenced list).

### Clear Report
**Route**: `POST /api/assistant`
**Payload**:
```json
{
  "action": "clearReport",
  "namespace": "default"
}
```

**Steps**:
- Read-modify-write `assistant-state` ConfigMap:
  1. Decode `data["state.json"]`
  2. Set `report = ""`
  3. Encode and apply

---

## Implementation Notes

### Web Panel (AssistantPanel.tsx)

**States**:
- **Not installed**: Show install form (namespace, token SecureField, image, spend cap, monitor namespaces, mode selector).
- **Installed**: Show control center (status pill, summary strip, live issues, autonomy card, silenced list, audit section, pod card, kill-switch, credentials, uninstall).

**Sections**:

1. **Install form**:
   - Namespace field: text input + dropdown (existing namespaces).
   - Token: SecureField ("Password" field), never shown in plain text, never logged.
   - Image: text input (default provided).
   - Spend cap: number input.
   - Monitor namespaces: multi-select menu or comma-separated list.
   - Manifest preview (collapsible):
     - YAML output from `AssistantInstaller.manifestYAML()` (token MASKED as `***SECRET***`).
     - Do NOT show the Secret YAML in preview (show only RBAC, ConfigMaps, Deployment).
   - Install button: calls `/api/assistant {action: 'install', ...}`.

2. **Status pill**: "active" (green) if enabled, "paused" (gray) if disabled.

3. **Summary strip** (at-a-glance stats):
   - Status: "Active" | "Paused"
   - Awaiting: count of queued suggestions
   - Live issues: count of unhealthy pods + degraded deployments
   - Fixed: audit count of "success"
   - Failed: audit count of "failure"
   - Spend: "$X.XX / $Y" (from agent status)
   - Token: "Xd left" (green), "Xd left" (yellow if <30d), "expired" (red)

4. **Live issues section**:
   - List of current cluster problems (not from audit, but live from cache).
   - Each issue shows location, reason, silence button.

5. **Autonomy card**:
   - Three mode buttons: Auto, Advisory, Quiet-hours.
   - If "Quiet-hours" selected, show window input ("HH:MM-HH:MM") + Save button.
   - Webhook URL input + Save button.
   - Info: "Signal notifications configured in Settings tab."

6. **Silenced section** (if any silenced):
   - List of silenced fingerprints with Unsilence buttons.

7. **Audit section**:
   - Latest 10 entries by default.
   - Each entry: glyph (✓/✗/▸/•), incident, proposal, command, detail, tier, timestamp.
   - Expandable: shows full detail + analysis (markdown) + revert button (if backupRef).
   - Context menu: "Silence this incident".
   - "See all" button if >10 entries (opens modal).

8. **Pod card**:
   - Pod name (selectable text).
   - Status pill (Running, Failed, Pending, etc.) + restart count.
   - "View pod" button (navigates to Pods panel with pod focused).

9. **Kill-switch card**:
   - Toggle: "Pause" (red) or "Resume" (green).
   - Instant effect (no confirmation needed).
   - Text: "Agent is acting on incidents" | "Agent is paused".

10. **Credentials card**:
    - SecureField: "New CLAUDE_CODE_OAUTH_TOKEN".
    - "Update token & restart" button (calls `/api/assistant {action: 'updateToken', ...}`).
    - "Restart agent" button (calls `/api/assistant {action: 'restart', ...}`).

11. **Uninstall card**:
    - Guarded button (role: destructive).
    - Confirmation dialog: "Remove the agent Deployment, RBAC, and token. Keeps the audit history."
    - Calls `/api/assistant {action: 'uninstall', ...}`.

### Server Route (assistant.ts)

**POST /api/assistant**

```typescript
export async function POST(req: Request): Promise<Response> {
  const {
    action, // 'install' | 'uninstall' | 'setMode' | 'kill' | 'updateToken' | 'restart' | 'silence' | 'unsilence' | 'clearReport'
    namespace,
    token, // for install/updateToken
    image, // for install
    spendCapUsd, // for install
    workerModel, // for install (optional, default provided)
    supervisorModel, // for install (optional, default provided)
    pollIntervalMs, // for install (optional)
    maxPerResourcePerHour, // for install (optional)
    maxPerNight, // for install (optional)
    maxAttemptsPerIncident, // for install (optional)
    confirmPolls, // for install (optional)
    monitorNamespaces, // for install (optional, comma-separated)
    mode, // for setMode ('auto' | 'advisory' | 'window')
    window, // for setMode (e.g. "22:00-07:00")
    enabled, // for kill (boolean)
    fingerprint, // for silence/unsilence
  } = await req.json();

  try {
    switch (action) {
      case 'install':
        return await installAssistant(namespace, token, image, { /* config */ });
      case 'uninstall':
        return await uninstallAssistant(namespace);
      case 'setMode':
        return await setMode(namespace, mode, window);
      case 'kill':
        return await setKillSwitch(namespace, enabled);
      case 'updateToken':
        return await updateToken(namespace, token);
      case 'restart':
        return await restartAgent(namespace);
      case 'silence':
        return await silenceIncident(namespace, fingerprint);
      case 'unsilence':
        return await unsilenceIncident(namespace, fingerprint);
      case 'clearReport':
        return await clearReport(namespace);
      default:
        return json({ error: 'unknown action' }, { status: 400 });
    }
  } catch (err) {
    // Log error WITHOUT token
    console.error(`assistant action ${action}:`, err.message);
    return json({ error: err.message }, { status: 500 });
  }
}
```

**Key behaviors**:
- Never log or echo the token.
- Use existing `runProcess` helper to invoke `kubectl` with argv (no shell).
- Prefix all kubectl args with `['--context', context]` if context is set.
- Return `{ success: true }` or `{ error: string }` as JSON.
- Use read-modify-write pattern for ConfigMap patches (merge updates, never clobber).

### Helper Module (assistant-templates.ts)

Template functions (reused from Swift's AssistantInstaller):

```typescript
export function namespaceYAML(ns: string): string { /* ... */ }
export function secretYAML(token: string, issuedAt: string, namespace: string): string { /* ... */ }
export function manifestYAML(config: AssistantInstallConfig): string { /* ... */ }
export function rbac(ns: string): string { /* ... */ }
export function configMaps(ns: string): string { /* ... */ }
export function deployment(config: AssistantInstallConfig): string { /* ... */ }

export interface AssistantInstallConfig {
  image: string;
  installNamespace: string;
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

export function maskToken(yaml: string): string {
  // Replace `token: "sk-..."` with `token: "***SECRET***"` in YAML
}

export function deriveStatus(
  deployment: Deployment | null,
  configMap: ConfigMap | null,
  secret: Secret | null,
  pod: Pod | null
): {
  isInstalled: boolean;
  health: 'active' | 'paused' | 'degraded';
  mode: string;
  window: string;
  tokenExpiry: { daysRemaining: number; level: 'ok' | 'warning' | 'expired' } | null;
} { /* ... */ }

export function parseTokenExpiry(issuedAt: string, now: Date): {
  daysRemaining: number;
  level: 'ok' | 'warning' | 'expired';
} { /* ... */ }
```

---

## Watch Resources

The web app's resource watch store (reusing existing shared infrastructure) must track:

- **Deployments**: filtered to `metadata.name == "helmsman-assistant"` across all namespaces.
- **Pods**: filtered to label `app.kubernetes.io/name == "helmsman-assistant"` across all namespaces.
- **ConfigMaps**: filtered to `metadata.name in [assistant-config, assistant-state, assistant-backups]` across all namespaces.
- **Secrets**: filtered to `metadata.name == "assistant-claude-token"` across all namespaces.
- **Namespaces**: all (for install target dropdown and monitor scope multi-select).

The Assistant panel subscribes to these watches via the global resource store (analogous to Swift's `ClusterCache`).

---

## Validation Rules

**Install form**:
- Token: non-empty after trim.
- Image: non-empty, repository lowercase (no uppercase; Kubernetes rejects as InvalidImageName).
- Namespace: non-empty, lowercase.
- Spend cap: positive integer or 0.

**Mode selector**:
- "auto" requires no window.
- "window" requires window format "HH:MM-HH:MM" (client may validate loosely; server trusts agent to parse).

**Kill-switch**:
- Boolean; no validation.

**Silence**:
- Fingerprint must be non-empty.

---

## Error States & Empty States

**Install not yet done**:
- Show "Install the in-cluster assistant" banner + form.

**Namespace doesn't exist**:
- Show warning: "Namespace '...' doesn't exist — you'll be asked to create it on Install."
- Offer confirmation dialog to create on Install.

**Pod not found yet**:
- Show "No agent pod found yet — it may still be scheduling or failing to pull the image."

**No live issues**:
- Show "Cluster is clean — nothing to remediate."

**No audit entries**:
- Show "No actions yet."

**No silenced incidents**:
- Don't show the silenced section.

**Token expired**:
- Summary strip shows "Token: expired — re-run setup-token" (red).
- Credentials card shows warning.

**Action error**:
- Display error banner at top of panel (selectable text, monospace, red background).

---

## Permission Model

All cluster writes use `runProcess(['kubectl', '--context', context, ...])` with argv, never shell. No new npm deps beyond shadcn. The token is ONLY placed in the applied Secret and never logged; it is only visible in SecureField input (masked in preview).

---

## Atomic Checks

Before implementation, verify:

1. **Install form previews + applies with masked token**: Token is `***SECRET***` in the preview YAML, but correctly applied to the Secret.
2. **Status shows installed/mode/health**: Derives from Deployment, ConfigMap, Secret, Pod.
3. **Mode selector patches**: Calls setMode, ConfigMap is updated, UI reflects new mode.
4. **Kill-switch + uninstall guarded**: Both require confirmation, error handling is robust.
5. **All existing routes remain intact**: New `/api/assistant` doesn't break `/api/apply`, `/api/delete`, etc.
6. **All tests pass**: `pnpm --filter @helmsman/server test`, `pnpm --filter web typecheck && build && test`.

