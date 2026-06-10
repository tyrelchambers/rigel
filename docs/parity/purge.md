# Purge (App Removal) — normative behavior spec

## Overview

**Purge** is the unified full-app removal flow: the user selects an app (by its
root deployment name and namespace), sees a preview of every resource that would
be deleted, types the app name to confirm, and executes the deletion. The flow
detects Helm-managed releases and uninstalls them first. Discovery is lossless:
it finds resources by label (`app.kubernetes.io/instance=<name>`) and name-prefix
matching, spanning Deployments, StatefulSets, Services, Ingresses, Secrets,
ConfigMaps, PersistentVolumeClaims (PVCs), and extras (DaemonSets, Jobs, CronJobs,
ServiceAccounts).

Entry points:
1. **Overview panel**: "Purge an app…" button → app picker → discovery → confirm sheet.
2. **Chat action block**: `kind:purge` → server returns `{purge:true,name,namespace}` →
   web opens the typed-name confirm sheet (no picker needed, already targeted).

## Resource Discovery & Filtering

### Guardrails (hard deny at every stage)

**Protected namespaces** (never purgeable):
- `kube-system`, `kube-public`, `kube-node-lease`, `default-system`, `cert-manager`, `cnpg-system`
- Prefixes: `kube-*`, `cattle-*`, `fleet-*`, `tigera-*`, `calico-*`

**Shared infrastructure workloads** (never deleted, only their data):
- `postgres`, `mysql`, `mariadb`, `redis`, `postgres-pooler`

### Discovery algorithm

Given `instance` (deployment name) and `namespace`:

1. **Namespace scope check**: Reject if `namespace` is protected.
2. **Workload core matching**:
   - Extract identity core from `instance` via `core(name)`:
     - Lowercase, split on `-` or `_`.
     - Drop known role/env tokens: `staging`, `stg`, `production`, `prod`, `dev`, `test`,
       `web`, `api`, `server`, `client`, `app`, `svc`, `service`, `worker`, `deploy`,
       `deployment`, `frontend`, `backend`, `ui`, `site`.
     - Rejoin the kept tokens (if all are role tokens, keep all; otherwise keep non-role only).
   - Match related workloads (Deployments, StatefulSets, DaemonSets): prefix match on
     identity core, guarded by minimum core length (≥4) to prevent 1–3 char cores from
     over-merging (e.g., a 3-char root can only match by exact equality).
3. **Dependent resource matching** (Services, Ingresses, Secrets, ConfigMaps, PVCs):
   - Loose name relation: `isRelated(resource.name, instance)` applies the same core
     matching as workloads, or exact match if root core is < 4 chars.
4. **Helm release detection**:
   - Scan Secrets in the namespace for `sh.helm.release.v1.<release>.v<N>` pattern.
   - Extract the `<release>` token (strip prefix and final `.v<N>` segment).
   - Keep only if the release name is related to the instance by core matching.

### Resource types and kubectl targets

| Kind | Kubectl | Selected by default |
|------|---------|-------------------|
| `deployment` | `deployment` | Yes |
| `statefulset` | `statefulset` | Yes |
| `daemonset` | `daemonset` | Yes |
| `service` | `service` | Yes |
| `ingress` | `ingress` | Yes |
| `secret` | `secret` | Yes |
| `configmap` | `configmap` | Yes |
| `persistentvolumeclaim` | `pvc` | **No** (data opt-in) |
| `job` | `job` | Yes |
| `cronjob` | `cronjob` | Yes |
| `serviceaccount` | `serviceaccount` | Yes |

**Data safety**: PVCs start **unselected** (user must opt-in). All others **selected** by
default (user may deselect).

## User Interface & Interaction

### Entry point 1: Overview "Purge an app…" button

**Picker sheet** (`PurgePickerSheet`):
- Searchable list of deployments in purgeable namespaces.
- Group by namespace; show name only (no pod count or status).
- Search filter: match deployment name or namespace substring (case-insensitive).
- Empty state: "No purgeable deployments" or "No matches."
- User picks a deployment → call discovery → hide picker.

**Discovery call**:
- Input: `instance`, `namespace`.
- Output: `PurgePlan` (resources list, helm release, blocked reason, db hint).

### Entry point 2: Chat `kind:purge` action

**Server response** (from `/api/action`):
```json
{
  "purge": true,
  "name": "<instance>",
  "namespace": "<namespace>"
}
```

Client immediately opens the confirm sheet (no picker); discovery must be called by the
web app with the provided name/namespace.

### Confirm sheet (`PurgeSheet`)

**Header**:
- Trash icon (failed/destructive color).
- "Purge <appName>".
- "namespace: <ns>" (secondary text, mono font).
- Red accent border (opacity 0.5).

**Blocked state** (if `blockedReason` is set):
- Lock icon.
- Display the reason (e.g., "kube-system is a protected system namespace").
- No resource list, no confirm input, no purge button.

**Normal state** (if not blocked):

1. **Warning prose**:
   > "This permanently deletes the selected resources from the cluster. Deselect anything that should survive — the typed-name confirmation below is the real gate."

2. **Resource list**:
   - Scrollable list (max height ~240px).
   - One row per resource.
   - **Toggle checkbox** (default: on, except PVCs which default off).
   - **Kind badge**: mono font, accent color, `resourceKind.rawValue` (e.g., "deployment", "pvc").
   - **Name**: mono font, truncated middle.
   - Toggle all selected resources — the list shows a gating summary.

3. **Database hint** (if `databaseHint` is present; optional):
   - Separate, visually distinct block (failed/destructive color tint).
   - **Toggle**: "Also drop database <hint> — irreversible" (semibold, failed color).
   - **Prose**: "Deletes the app's logical database inside the shared server. Off by default."
   - **Default**: OFF (never auto-delete the database).
   - **Note**: v1 scoping — the UI accepts the toggle, but execution is informational
     only (returns a non-ok outcome telling the operator to drop the DB manually).

4. **Confirm input**:
   - Label: "CONFIRM".
   - Text field: placeholder "type <appName> to confirm".
   - Mono font, smaller size.
   - Input chrome: highlight when **exactly matches** `appName`.

5. **Footer buttons**:
   - Cancel button (secondary styling).
   - Purge button (trash icon + "Purge" label, destructive color).
   - Purge button is **disabled** unless:
     - Not blocked (`blockedReason === null`).
     - At least one resource is selected.
     - Typed text **exactly matches** `appName` (case-sensitive).
   - Pressing Return in the confirm input does **NOT** submit (the button is the only gate).

## Server-side API

### `POST /api/purge`

**Request body**:
```typescript
{
  namespace: string;
  instance: string;           // deployment name
  dryRun?: boolean;          // defaults to false
  helmRelease?: string;      // pre-discovered helm release name (optional hint)
}
```

**Response: dry-run mode** (`dryRun=true`):
```typescript
{
  ok: true;
  discovered: [
    { kind: string; name: string; namespace: string },
    …
  ];
  helmRelease?: string;      // if helm-managed
  blockedReason?: string;    // if namespace/app is off-limits
}
```

**Response: execute mode** (`dryRun=false`):
```typescript
{
  ok: boolean;
  results: [
    {
      resource: string;      // e.g. "helm/memos", "deployment/memos", "pvc/memos-data"
      ok: boolean;           // true if deletion succeeded
      detail: string;        // "deleted", "exit 1", error message, or manual-action hint
    },
    …
  ];
}
```

### Execution order

1. **If Helm-managed**: Run `helm uninstall <release> -n <namespace>` first.
   - Logs the outcome as a result entry.
   - If it fails, execution stops (do NOT proceed to kubectl deletes).
2. **Sweep remaining resources**: For each selected resource, run
   `kubectl delete <kind> <name> -n <namespace>`.
3. **Database drop hint** (if opted in, v1 scoping):
   - Return a non-ok result: `resource: "database/<db-name>"`, `ok: false`,
     `detail: "DB drop requested — run manually…"`.

### Implementation detail: kind list & arg building

**Discoverable kinds** (in discovery query):
```
deployments, statefulsets, daemonsets, services, ingresses, configmaps, secrets, persistentvolumeclaims, jobs, cronjobs, serviceaccounts
```

**Kubectl shorthand normalization**:
- `pvc` ↔ `persistentvolumeclaim`
- `configmap` ↔ `cm`
- `ingress` ↔ `ing`
- `service` ↔ `svc`
- `cronjob` ↔ `cron` (less common)

**Discovery query** (dry-run):
```bash
kubectl get <kinds> \
  -l app.kubernetes.io/instance=<instance> \
  -n <namespace> \
  -o json
```

Fallback if label doesn't match: name-prefix filtering in post-processing (or secondary query
with `--field-selector metadata.name=<instance>*`).

**Delete commands** (execute):
```bash
kubectl delete <kind> <name> -n <namespace>
```

For each selected resource in the confirmed plan.

**Helm uninstall** (if helm-managed):
```bash
helm uninstall <release> -n <namespace>
```

## State & Data Flow

### PurgePlan (client-side model)

```typescript
{
  appName: string;           // root deployment name
  namespace: string;
  resources: [
    {
      kind: string;          // "deployment", "pvc", etc.
      name: string;
      namespace: string;
      selected: boolean;     // user toggle state
    },
    …
  ];
  helmRelease?: string;      // null if not helm-managed
  databaseHint?: string;     // null if no discoverable DB
  dropDatabase: boolean;     // user toggle, default false
  blockedReason?: string;    // non-null blocks purge entirely
}
```

### Discovery → Confirm flow

1. User picks app (picker or chat action) → `instance`, `namespace`.
2. **Web calls** `POST /api/purge` with `{namespace, instance, dryRun: true}`.
3. **Server discovers** resources, detects helm release, checks guardrails.
4. **Server returns** discovered list or block reason.
5. **Web populates** PurgePlan, opens confirm sheet.
6. User reviews, deselects as needed, types name, clicks Purge.
7. **Web calls** `POST /api/purge` with `{namespace, instance, dryRun: false}` (and confirmed selection).
8. **Server executes** (helm uninstall, then kubectl deletes), returns results.
9. **Web displays** results (success list or error details).

### Watch integration

The purge flow does **NOT** require live watches; it reads the current state once (via
discovery query), shows it to the user, and executes the confirmed selection.
After execution, the web app's normal watch cycle will see the resources disappear.

## Edge cases & error handling

### Discovery edge cases

- **No resources found**: Show empty list (with message "No resources to delete").
- **Namespace protected**: Set `blockedReason`, hide controls.
- **Helm release not detected**: `helmRelease` stays `null`; proceed with kubectl deletes only.
- **Same-named resource in multiple namespaces**: Discovery is scoped to the target namespace only.

### Execution edge cases

- **Resource already deleted**: `kubectl delete` exits non-zero; log the exit code.
- **Helm uninstall fails**: Stop immediately; return the error; do NOT proceed to kubectl.
- **Partial failure** (some kubectl deletes fail): Continue with the rest; return all results.
- **User-selected resource is now protected**: Executor re-checks guardrails; skip silently
  (log as non-ok result: "skipped — protected namespace/workload").

### Confirm sheet gates

- **Block button while typing**: Disabled until text matches exactly (case-sensitive).
- **Block button if no resources selected**: Disabled if all are deselected.
- **Block if blockedReason**: Disable all controls; show lock icon.

## Relationship to chat action blocks

The `purge` action kind is **unique among action blocks**:
- Claude emits: `{"kind":"purge","name":<deployment>,"namespace":<ns>}`.
- App does **NOT** render a one-click "Run Purge" button (like other actions do).
- Instead, app routes `kind:purge` to the full confirm sheet flow (discovery + review).
- This prevents accidental one-click deletion; the typed-name gate is the structural safeguard.

The server `/api/action` endpoint **recognizes** `purge` and returns
`{purge:true,name,namespace}` instead of trying to build a kubectl command.

## Columns/fields in resource list (UI rendering)

| Field | Source | Type | Example |
|-------|--------|------|---------|
| `kind` | Resource kind | Badge | "deployment" |
| `name` | Resource metadata.name | String | "memos", "memos-postgres" |
| `selected` | User toggle | Boolean | true/false |

## Confirmation requirements

- **Typed-name gate**: User must type the exact app name (`appName`) in the confirm input.
  - Match is **case-sensitive**, **exact** (not prefix).
  - Input field placeholder: `"type <appName> to confirm"`.
  - Purge button disabled until match is true.
- **Selection gate**: At least one resource must be selected.
- **Namespace gate**: Target namespace must be purgeable (checked server-side; UI blocks at picker stage).

## Summary: exact kubectl commands produced

**Discovery** (implicit in server route):
```bash
kubectl get deployments,statefulsets,daemonsets,services,ingresses,configmaps,secrets,persistentvolumeclaims,jobs,cronjobs,serviceaccounts \
  -l app.kubernetes.io/instance=<instance> -n <namespace> -o json
```

**Helm uninstall** (if helm-managed):
```bash
helm uninstall <release> -n <namespace>
```

**Kubectl delete** (per selected resource):
```bash
kubectl delete <kind> <name> -n <namespace>
```

All invocations use Bun.spawn with argv array (no shell); context flag prepended by runProcess.
