# Workloads panel — normative behavior spec

This spec documents the exact behavior for porting the Swift Workloads panel
(`Sources/Helmsman/Panels/Workloads/`) to the web app. It is the source of truth
for the web port and SHALL NOT be modified without manager approval.

## Overview

The Workloads panel presents four Kubernetes resource kinds in a single view:
**StatefulSets**, **DaemonSets**, **Jobs**, and **CronJobs**. The user toggles
between kinds using a pill-button bar, and the table updates to show only the
selected kind. All data comes from the live cluster cache (fed by WebSocket
watches); search filters across multiple fields per kind.

## § 1. Resource kinds and subscriptions

The panel watches four resource kinds with namespace scoping:

| Kind | kubectl resource | watch key | namespace-scoped? |
|------|------------------|-----------|------------------|
| StatefulSet | `statefulsets` (apps/v1) | `statefulsets` | yes |
| DaemonSet | `daemonsets` (apps/v1) | `daemonsets` | yes |
| Job | `jobs` (batch/v1) | `jobs` | yes |
| CronJob | `cronjobs` (batch/v1) | `cronjobs` | yes |

**Subscribe pattern** (from `apps/web/src/panels/deployments/DeploymentsPanel.tsx`):

```typescript
useEffect(() => {
  const ns = namespaceFilter ?? "*";
  subscribe("statefulsets", ns);
  subscribe("daemonsets", ns);
  subscribe("jobs", ns);
  subscribe("cronjobs", ns);
  return () => {
    unsubscribe("statefulsets", ns);
    unsubscribe("daemonsets", ns);
    unsubscribe("jobs", ns);
    unsubscribe("cronjobs", ns);
  };
}, [namespaceFilter]);
```

When `namespaceFilter` changes, the old subscriptions are torn down and new ones
for the new namespace are established. When all-namespaces mode is active
(`namespaceFilter === null`), pass `"*"` to the watch.

## § 2. UI structure

### Header (shared across all kinds)

- **Title**: "Workloads"
- **Count badge**: Shows the count of resources in the currently selected kind
  (after namespace/search filters).
- **Loading spinner**: Shown when `store.isLoading === true`.
- **Search input**: A text field that filters across all fields of the selected
  kind (see below for per-kind search fields).

### Kind toggle bar

Four pill buttons, one for each kind:
- StatefulSets (default on first load)
- DaemonSets
- Jobs
- CronJobs

When clicked, change the active kind; table below updates. Active pill uses primary
accent color; inactive pills use subtle background. Display is mutually exclusive —
only one kind's rows appear at a time.

### Error banner

If `store.error` is truthy, display a monospace red error banner above the table.

### Table structure

One row per resource in the filtered + sorted list. Structure depends on active kind
(see § 3 below for columns per kind).

### Empty states

1. **No resources exist** (`allResources.length === 0` after loading):
   "No <Kind> found"
2. **Search matches nothing** (`allResources.length > 0` but `filtered.length === 0`):
   "No <Kind> match search"

## § 3. Columns and display helpers per kind

### 3a. StatefulSets

**Table columns** (left to right):

| Column | Source | Format | Notes |
|--------|--------|--------|-------|
| Name | `metadata.name` | Monospace, clickable to expand | Links to detail row |
| Namespace | `metadata.namespace` | Monospace tag, muted | Shows "default" if omitted |
| Ready | `status.readyReplicas ?? 0` / `spec.replicas ?? status.replicas ?? 0` | Badge: `X/Y`; green if X===Y, red otherwise | From `readyFraction` helper |
| Age | `metadata.creationTimestamp` | Relative: "5s", "3m", "2h", "1d" | From `relativeAge` helper |
| Actions | — | Dropdown menu (MoreHorizontal icon) | See § 4 |

**Search fields**: `metadata.name`, `metadata.namespace`

**Detail row** (when expanded, optional): Display spec/status summary (pods, strategy, etc.)
For now, a simple detail row showing readyReplicas and other metadata is acceptable.

### 3b. DaemonSets

**Table columns**:

| Column | Source | Format | Notes |
|--------|--------|--------|-------|
| Name | `metadata.name` | Monospace, clickable to expand | Links to detail row |
| Namespace | `metadata.namespace` | Monospace tag, muted | Shows "default" if omitted |
| Ready | `status.numberReady ?? 0` / `status.desiredNumberScheduled ?? 0` | Badge: `X/Y`; green if X===Y, red otherwise | From `readyFraction` helper |
| Age | `metadata.creationTimestamp` | Relative: "5s", "3m", "2h", "1d" | From `relativeAge` helper |
| Actions | — | Dropdown menu | See § 4 |

**Search fields**: `metadata.name`, `metadata.namespace`

**Detail row**: Optional summary of status.

### 3c. Jobs

**Table columns**:

| Column | Source | Format | Notes |
|--------|--------|--------|-------|
| Name | `metadata.name` | Monospace, clickable to expand | Links to detail row |
| Namespace | `metadata.namespace` | Monospace tag, muted | Shows "default" if omitted |
| Status | Phase derived from conditions/counts | Badge: "Complete", "Running", "Failed", "Pending", "Suspended" | Green for Complete/Running, red for Failed, yellow for Pending/Suspended |
| Completions | `status.succeeded ?? 0` / `spec.completions ?? 1` | Monospace text: `X/Y` | e.g. "3/3" |
| Duration | Wall-clock run time | Monospace text: "42s", "5m", "1h" | Only shown for completed jobs; nil otherwise |
| Age | `metadata.creationTimestamp` | Relative | From `relativeAge` helper |
| Actions | — | Dropdown menu | See § 4 |

**Search fields**: `metadata.name`, `metadata.namespace`, `phase`

**Job phase logic** (mirror `Sources/Helmsman/Cluster/WorkloadTypes.swift` Job.phase):
```typescript
function jobPhase(job: Job): string {
  if (job.spec?.suspend === true) return "Suspended";
  const conditions = job.status?.conditions ?? [];
  if (conditions.some(c => c.type === "Failed" && c.status === "True")) return "Failed";
  if (conditions.some(c => c.type === "Complete" && c.status === "True")) return "Complete";
  if ((job.status?.active ?? 0) > 0) return "Running";
  return "Pending";
}
```

**Job duration logic** (mirror `Job.duration`):
```typescript
function jobDuration(job: Job): string | null {
  const start = job.status?.startTime;
  if (!start) return null;
  const end = job.status?.completionTime ?? new Date();
  const dt = (new Date(end).getTime() - new Date(start).getTime()) / 1000; // seconds
  if (dt < 60) return `${Math.floor(dt)}s`;
  if (dt < 3600) return `${Math.floor(dt / 60)}m`;
  return `${Math.floor(dt / 3600)}h`;
}
```

### 3d. CronJobs

**Table columns**:

| Column | Source | Format | Notes |
|--------|--------|--------|-------|
| Name | `metadata.name` | Monospace, clickable to expand | Links to detail row |
| Namespace | `metadata.namespace` | Monospace tag, muted | Shows "default" if omitted |
| Schedule | `spec.schedule ?? "—"` | Monospace in accent badge | e.g. "0 2 * * *" |
| Suspended | `spec.suspend === true` | Badge "Suspended" (only when true) | Yellow/warning color; omit row if false |
| Active | `status.active?.length ?? 0` | Text: "N active" | Only shown if count > 0 |
| Last Schedule | Time since `status.lastScheduleTime` | Relative: "5s ago", "3m ago", etc. | Nil if never scheduled |
| Age | `metadata.creationTimestamp` | Relative | From `relativeAge` helper |
| Actions | — | Dropdown menu | See § 4 |

**Search fields**: `metadata.name`, `metadata.namespace`, `spec.schedule`

**Last-schedule-ago logic** (mirror `CronJob.lastScheduleAgo`):
```typescript
function lastScheduleAgo(cronJob: CronJob): string | null {
  const t = cronJob.status?.lastScheduleTime;
  if (!t) return null;
  const dt = (Date.now() - new Date(t).getTime()) / 1000; // seconds
  if (dt < 60) return `${Math.floor(dt)}s ago`;
  if (dt < 3600) return `${Math.floor(dt / 60)}m ago`;
  if (dt < 86400) return `${Math.floor(dt / 3600)}h ago`;
  return `${Math.floor(dt / 86400)}d ago`;
}
```

**Suspended detection** (test-observable):
```typescript
function isCronJobSuspended(cronJob: CronJob): boolean {
  return cronJob.spec?.suspend === true;
}
```

## § 4. User actions and confirm-sheet wiring

### 4a. StatefulSet actions

**Rows in the dropdown menu**:

| Action | Condition | Confirm-sheet payload |
|--------|-----------|----------------------|
| Restart… | Always shown | `{ kind: "restart", name: sts.metadata.name, namespace: sts.metadata.namespace ?? "default", resourceKind: "statefulset", label: "Restart statefulset <name>" }` |
| Scale… | Always shown | Opens scale dialog; on confirm: `{ kind: "scale", name: sts.metadata.name, namespace: sts.metadata.namespace ?? "default", replicas: <input>, label: "Scale <name> to <n> replicas" }` |
| View YAML… | Always shown | (Not yet implemented; placeholder) |
| Delete StatefulSet | Always shown (destructive role) | `{ kind: "deleteWorkload", name: sts.metadata.name, namespace: sts.metadata.namespace ?? "default", resourceKind: "statefulset", label: "Delete statefulset <name>", destructive: true }` |

**Scale dialog**:
- Prompt: "Scale <name>" with input for replica count (0–50).
- On confirm, send action block with replicas clamped to [0, 50].

**Kubectl equivalent**:
- Restart: `kubectl rollout restart statefulset/<name> -n <ns>`
- Scale: `kubectl scale statefulset/<name> --replicas=<n> -n <ns>`
- Delete: `kubectl delete statefulset/<name> -n <ns>`

### 4b. DaemonSet actions

**Rows in the dropdown menu**:

| Action | Condition | Confirm-sheet payload |
|--------|-----------|----------------------|
| Restart… | Always shown | `{ kind: "restart", name: ds.metadata.name, namespace: ds.metadata.namespace ?? "default", resourceKind: "daemonset", label: "Restart daemonset <name>" }` |
| View YAML… | Always shown | (Not yet implemented; placeholder) |
| Delete DaemonSet | Always shown (destructive role) | `{ kind: "deleteWorkload", name: ds.metadata.name, namespace: ds.metadata.namespace ?? "default", resourceKind: "daemonset", label: "Delete daemonset <name>", destructive: true }` |

**Kubectl equivalent**:
- Restart: `kubectl rollout restart daemonset/<name> -n <ns>`
- Delete: `kubectl delete daemonset/<name> -n <ns>`

### 4c. Job actions

**Rows in the dropdown menu**:

| Action | Condition | Confirm-sheet payload |
|--------|-----------|----------------------|
| View YAML… | Always shown | (Not yet implemented; placeholder) |
| Delete Job | Always shown (destructive role) | `{ kind: "deleteWorkload", name: job.metadata.name, namespace: job.metadata.namespace ?? "default", resourceKind: "job", label: "Delete job <name>", destructive: true }` |

**Kubectl equivalent**:
- Delete: `kubectl delete job/<name> -n <ns>`

### 4d. CronJob actions

**Rows in the dropdown menu**:

| Action | Condition | Confirm-sheet payload |
|--------|-----------|----------------------|
| Trigger now… | Always shown | `{ kind: "triggerCronJob", name: cj.metadata.name, namespace: cj.metadata.namespace ?? "default", pod: <generated-job-name>, label: "Trigger <name>" }` |
| Suspend… | Only if NOT suspended | `{ kind: "suspendCronJob", name: cj.metadata.name, namespace: cj.metadata.namespace ?? "default", label: "Suspend cronjob <name>" }` |
| Resume… | Only if suspended | `{ kind: "resumeCronJob", name: cj.metadata.name, namespace: cj.metadata.namespace ?? "default", label: "Resume cronjob <name>" }` |
| View YAML… | Always shown | (Not yet implemented; placeholder) |
| Delete CronJob | Always shown (destructive role) | `{ kind: "deleteWorkload", name: cj.metadata.name, namespace: cj.metadata.namespace ?? "default", resourceKind: "cronjob", label: "Delete cronjob <name>", destructive: true }` |

**Kubectl equivalent**:
- Suspend: `kubectl patch cronjob/<name> -n <ns> --type=merge -p '{"spec":{"suspend":true}}'`
- Resume: `kubectl patch cronjob/<name> -n <ns> --type=merge -p '{"spec":{"suspend":false}}'`
- Trigger: `kubectl create job <job-name> --from=cronjob/<name> -n <ns>`
  (job-name is pre-generated; see § 4e below)
- Delete: `kubectl delete cronjob/<name> -n <ns>`

### 4e. Trigger job-name generation

When "Trigger now…" is clicked, a unique job name is generated **at the time of
click**, not deferred. This ensures the confirm-sheet preview shows the exact name
that will be created.

**Algorithm** (mirror `Sources/Helmsman/Cluster/WorkloadTypes.swift` CronJob.manualRunName):

```typescript
/**
 * Generate a unique name for a manually triggered cronjob run.
 * Takes timestamp as parameter for test determinism.
 */
export function generateTriggerJobName(cronName: string, now: number = Date.now()): string {
  const stamp = Math.floor(now / 1000) % 100000; // Last 5 digits of Unix timestamp
  const base = cronName.length > 40 ? cronName.substring(0, 40) : cronName;
  return `${base}-manual-${stamp}`;
}
```

**Test case example**:
- CronJob name: `backup-db`
- Timestamp: `1686789123000` (Date.now() in ms) = `1686789123` (Unix seconds)
- `stamp = 1686789123 % 100000 = 89123`
- Result: `backup-db-manual-89123`

**Confirm-sheet display**:
The action block includes `pod: <generated-job-name>`. The confirm sheet shows:
```
kubectl create job backup-db-manual-89123 --from=cronjob/backup-db -n default
```

## § 5. Filtering and sorting

### Namespace filtering

All four kinds respect the global `store.namespaceFilter`:
- If `null` (all namespaces): subscribe with `"*"` and include all resources.
- If a string (specific namespace): subscribe with that namespace and include only
  resources in that namespace.

### Search filtering

Search is per-kind and is applied **after** namespace filtering. Case-insensitive
substring match across the listed fields. Join fields with a space and search
across the concatenation:

```typescript
function matchesSearch(
  name: string,
  namespace: string | undefined,
  fields: string[] = [],
  searchTerm: string
): boolean {
  if (!searchTerm.trim()) return true;
  const all = [name, namespace, ...fields].filter(Boolean).join(" ");
  return all.toLowerCase().includes(searchTerm.toLowerCase());
}
```

### Sorting

Within each kind, sort by:
1. Namespace (ascending alphabetical)
2. Name (ascending alphabetical, locale-aware)

```typescript
function compareWorkloads(a: Workload, b: Workload): number {
  const aNs = a.metadata.namespace ?? "";
  const bNs = b.metadata.namespace ?? "";
  if (aNs !== bNs) return aNs.localeCompare(bNs);
  return a.metadata.name.localeCompare(b.metadata.name);
}
```

## § 6. ConfirmSheet integration

The panel uses the existing `<ConfirmSheet />` component (shadcn sheet) to display
action confirmations. The component:

1. Takes an `action` prop (or `null` to hide).
2. Reads from the store's current context (namespace, cluster).
3. Calls the server `/api/action` endpoint to fetch and display the exact kubectl
   command.
4. On confirmation, executes the command and closes.

The action block JSON passed to the sheet MUST have:
- `kind` (one of the action kinds listed in § 4)
- `name` (target resource name)
- `namespace` (target namespace)
- `label` (button/sheet title)
- Optional: `pod` (for triggerCronJob), `replicas` (for scale), `resourceKind` (for delete), etc.

See `docs/parity/contracts.md` §1 for the full schema.

## § 7. Implementation checklist (web builder reference)

### Files to create/modify

- **apps/web/src/panels/workloads/WorkloadsPanel.tsx** — Main component
  - Subscribe/unsubscribe on mount/namespace change
  - State: `search`, `activeKind`, `pendingAction`, `expanded` (for detail rows)
  - Render header, kind toggle bar, error banner, table
  - Wire actions to ConfirmSheet
  
- **apps/web/src/panels/workloads/workloadsDisplay.ts** — Display helpers
  - `relativeAge(iso, now)` — Relative timestamp format
  - `jobPhase(job)` — Job status logic
  - `jobDuration(job)` — Job duration computation
  - `jobCompletionsLabel(job)` — "X/Y" format
  - `lastScheduleAgo(cronJob)` — CronJob scheduling time
  - `generateTriggerJobName(cronName, now)` — Job name generation
  - `isCronJobSuspended(cronJob)` — Boolean check
  - `matchesSearch(resource, searchTerm, fields)` — Per-kind search
  - `sortWorkloads(resources, kind)` — Namespace-then-name sort
  - `readyFraction(ready, desired)` — Status badge text

- **apps/web/src/panels/workloads/types.ts** — TypeScript interfaces
  - `StatefulSet`, `DaemonSet`, `Job`, `CronJob` (mirror Kubernetes types)
  - Include metadata, spec, status sub-objects

- **apps/web/src/panels/workloads/workloads.test.ts** — Vitest unit tests
  - Test `jobPhase(…)` for all phases
  - Test `jobDuration(…)` for multiple durations
  - Test `lastScheduleAgo(…)` boundary conditions (seconds, minutes, hours, days)
  - Test `generateTriggerJobName(…)` with fixed timestamps
  - Test `isCronJobSuspended(…)`
  - Test search matching (case-insensitive, multiple fields)

- **apps/web/src/App.tsx** — Update route registration
  - Add `import WorkloadsPanel from "./panels/workloads/WorkloadsPanel"`
  - Add `"workloads"` to the `PANELS` array
  - Add route `<Route path="/workloads" element={<div className="h-full overflow-auto p-4"><WorkloadsPanel /></div>} />`

### No modification required

- **apps/server/src/actions.ts** — Already supports `restart`, `scale`, `deleteWorkload`,
  `suspendCronJob`, `resumeCronJob`, `triggerCronJob`
- **packages/k8s/** — Already contains type definitions and parsing
- **ConfirmSheet component** — Already wired for all action kinds

## § 8. Acceptance criteria

The web implementation is COMPLETE when:

1. **Live view**: The panel displays all four kinds of workloads in the live store
   (fed by WebSocket watches), with correct namespace filtering.

2. **Kind toggle**: Clicking kind pills switches the table without refetching; the
   count badge updates.

3. **Search and sort**: Search filters across per-kind fields (case-insensitive).
   Results are sorted by namespace then name.

4. **All columns**: Each kind displays its exact columns as documented in § 3,
   with correct formatting (badges, relative times, etc.).

5. **Actions**:
   - StatefulSet: Restart, Scale, Delete work and open confirm sheet.
   - DaemonSet: Restart, Delete work and open confirm sheet.
   - Job: Delete works and opens confirm sheet.
   - CronJob: Suspend/Resume (depending on state), Trigger (with pre-generated job
     name), Delete work and open confirm sheet.

6. **Confirm-sheet display**: The sheet shows the exact kubectl command matching
   the entry in § 4.

7. **Job-name generation**: `generateTriggerJobName(…)` is deterministic when passed
   a fixed timestamp; matches the Swift logic.

8. **Type safety**: TypeScript compiles without errors.

9. **Tests**:
   - `pnpm --filter web test` passes all tests in `workloads.test.ts`
   - `pnpm --filter web typecheck` passes
   - `pnpm --filter web build` succeeds

10. **Registration**: `/workloads` route works; "workloads" appears in the nav menu.

## § 9. Reference Swift source

- `Sources/Helmsman/Panels/Workloads/WorkloadsPanel.swift` — UI layout and action binding
- `Sources/Helmsman/Panels/Workloads/WorkloadsViewModel.swift` — Filtering and search logic
- `Sources/Helmsman/Cluster/WorkloadTypes.swift` — Data models and computed properties
- `Sources/Helmsman/Cluster/KubeTypes.swift` — StatefulSet type definition

## § 10. Reference web patterns

- `apps/web/src/panels/deployments/DeploymentsPanel.tsx` — Subscribe/unsubscribe,
  ConfirmSheet usage, state management
- `apps/web/src/panels/deployments/deploymentDisplay.ts` — Display helpers with
  test-friendly design (pass timestamp for determinism)
- `apps/web/src/panels/nodes/NodesPanel.tsx` — Multi-action dropdown menu pattern
