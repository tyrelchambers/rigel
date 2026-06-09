# Deployments Panel — Normative Parity Spec

## Overview
This spec documents the EXACT behavior of the Swift Deployments panel (`Sources/Helmsman/Panels/Deployments/`) for port to web. The web implementation MUST match field-by-field, action-by-action, and kubectl command-by-command.

---

## 1. Data Source & Subscription

**kubectl command:**
```
kubectl get deployments --watch -o json [-n <namespace> | --all-namespaces]
```

**Store location:** `resources['deployments']` (keyed by `metadata.uid`)

**Live updates:** Subscribe via `subscribe('deployments', namespaceFilter ?? '*')` feeding Zustand store at `apps/web/src/store/cluster.ts`

**Cache fields** (JSON paths from `kubectl get deployments -o json`):
- `metadata.name` — deployment name
- `metadata.namespace` — namespace (or "default" if omitted)
- `metadata.creationTimestamp` — ISO 8601 creation date
- `spec.replicas` — desired replica count (integer, defaults to 1)
- `spec.paused` — boolean, true if rollout is paused
- `spec.selector.matchLabels` — label selector object
- `spec.strategy.type` — "RollingUpdate" or "Recreate"
- `spec.strategy.rollingUpdate.maxSurge` — IntOrString (e.g. "25%", 1)
- `spec.strategy.rollingUpdate.maxUnavailable` — IntOrString
- `spec.template.spec.containers[]` — array of containers
  - `name` — container name
  - `image` — image repo:tag or @digest
  - `ports[]` — array of port objects, each with `containerPort`
  - `resources.requests` — object {cpu, memory, …}
  - `resources.limits` — object {cpu, memory, …}
- `status.replicas` — total replicas currently created
- `status.readyReplicas` — number of pods that are Ready (matched all container probes)
- `status.availableReplicas` — number of pods available for at least minReadySeconds
- `status.updatedReplicas` — number of pods with updated template spec

---

## 2. Display: LIST View (Main Table)

### Header
- **Title:** "Deployments"
- **Count badge:** `{filtered.length}` deployments visible
- **Search field:** case-insensitive substring match against name, namespace, image repo
- **Loading spinner:** show when `isLoading === true` (between subscribe request and first snapshot)

### Columns

| Column | Source | Format | Notes |
|--------|--------|--------|-------|
| **Namespace** | `metadata.namespace ?? "default"` | Monospace badge, muted | Always visible; sorts by ns then name |
| **Name** | `metadata.name` | Monospace, color varies (see Colors below) | Clickable to expand row details |
| **Image(s)** | `spec.template.spec.containers[0].image` | Monospace, secondary | Repo path (`:tag` or `@sha…` shown separately) |
| **Tag** | Image tag/digest extraction | Monospace pill, accent tint | `image@sha256:abc…` → `@abc` (short); untagged → `latest` |
| **Ready** | `{readyReplicas}/{replicas}` | Monospace pill, green if healthy else red | Health color: green if `readyReplicas == total`, red otherwise; total = `status.replicas ?? spec.replicas ?? 0` |
| **Updated** | `status.updatedReplicas ?? 0` | Monospace, muted | # pods with new template spec |
| **Available** | `status.availableReplicas ?? 0` | Monospace, muted | # pods available for at least minReadySeconds |
| **Age** | `relativeAge(metadata.creationTimestamp)` | Monospace, muted | "5s", "3m", "2h", "1d", or "—" |
| **Actions** | Context menu + row buttons | Buttons | See section 3 below |

### Row Colors (Name Field)

| Condition | Color | Meaning |
|-----------|-------|---------|
| Any pod has `errorReason != null` (CrashLoop, ImagePull, Failed, …) | Red | Error state — operator attention needed |
| `desired == 0` (scaled to zero) | Yellow/pending | Intentionally paused; no pods running |
| `updatedReplicas != desired \|\| readyReplicas != desired` AND no errors | Green/running | Actively rolling out; pods coming online |
| Otherwise | Default foreground | Stable and healthy |

**Rollout progress bar:** Show thin green bar at row bottom during active rollout. Fill = `updatedReplicas / desired` (0…1).

### Rollout Churn Chips

When `isRedeploying` (desired > 0, no error pods, `updated/ready != desired`):
- Show **up arrow + count** for `updatedReplicas` (new pods coming online)
- Show **down arrow + count** for `(total - updatedReplicas)` (old pods terminating)

### Row Expansion (Detail View)

Clicking the row name toggles expansion. Expanded view shows:

#### SPEC Block
- **Strategy:** `spec.strategy.type` with rolling update params (e.g. "RollingUpdate · maxSurge 25% · maxUnavailable 25%")
- **Selector:** `spec.selector.matchLabels` formatted as `key1=val1, key2=val2` (sorted by key)
- **Created:** `relativeAge(metadata.creationTimestamp)` (e.g. "42d ago")
- **Containers:** For each container in `spec.template.spec.containers`:
  - Container name (monospace, accent color)
  - Ports (if any): `:8080 :8443 …`
  - Image (monospace, secondary, full image string)
  - CPU request/limit pair (e.g. `req 500m / lim 1000m`)
  - Memory request/limit pair (e.g. `req 256Mi / lim 512Mi`)

#### PODS Block (child list)
- Count heading: `PODS ({childPods.length})`
- If no pods: "No matching pods"
- If pods exist: For each pod (sorted by name), show:
  - Phase indicator dot (Running=green, Pending=yellow, Failed=red, …)
  - Pod name (monospace, secondary, truncate middle)
  - Restart count (if > 0, yellow badge)
  - Ready fraction (monospace, muted)
  - Age (monospace, muted)

### Empty / Loading / Error States

| State | Display |
|-------|---------|
| **Loading** | Show spinner in header; table shows no rows until snapshot arrives |
| **No deployments** | Show "No deployments found" message |
| **Error** | Red banner at top with error text (monospace, small) |
| **Search filtered to zero** | Show "No deployments match search" |

---

## 3. User Actions

### Row Action Buttons (Top-Right of Each Row)

Five buttons appear on the right side of the row header when NOT expanded (or in a menu when expanded):

1. **Restart** (icon: `arrow.clockwise`) → action kind `restart`
2. **Scale** (icon: `arrow.up.arrow.down`) → prompt for replica count → action kind `scale`
3. **Rollback** (icon: `arrow.uturn.backward`) → action kind `rollback`
4. **Pause** (icon: `pause.fill`) OR **Resume** (icon: `play.fill`) → action kind `pause` or `resume` (depends on `spec.paused`)
5. **More (Context menu)** → secondary actions below

### Context Menu (Right-Click / More Button)

- **Ask Claude: Errors** → handoff to chat (not an action block)
- **Ask Claude: Logs** → handoff to chat
- **Ask Claude: Explain** → handoff to chat
- **Ask Claude: Rollout** → action kind `rollout` (kubectl execution)
- **---** (divider)
- **View YAML…** → open YAML viewer for `kind=deployment, name, namespace`
- **Manage…** → open management sheet (DEFERRED — see section 5)
- **Move to namespace…** → open move dialog (DEFERRED — see section 5)

---

## 4. Action Blocks & kubectl Commands

### Restart
- **kind:** `restart`
- **kubectl:** `kubectl rollout restart deployment/<name> -n <namespace>`
- **name:** deployment name
- **namespace:** deployment namespace
- **label:** "Restart deployment {name}"

### Scale
- **kind:** `scale`
- **kubectl:** `kubectl scale deployment/<name> --replicas=<N> -n <namespace>`
- **name:** deployment name
- **namespace:** deployment namespace
- **replicas:** integer (0–50, user-entered; prompt: "Enter replica count")
- **label:** "Scale {name} to {replicas} replicas"

### Rollback
- **kind:** `rollback`
- **kubectl:** `kubectl rollout undo deployment/<name> -n <namespace>`
- **name:** deployment name
- **namespace:** deployment namespace
- **label:** "Rollback {name} to previous version"

### Pause
- **kind:** `pause`
- **kubectl:** `kubectl rollout pause deployment/<name> -n <namespace>`
- **name:** deployment name
- **namespace:** deployment namespace
- **label:** "Pause rollout of {name}"

### Resume
- **kind:** `resume`
- **kubectl:** `kubectl rollout resume deployment/<name> -n <namespace>`
- **name:** deployment name
- **namespace:** deployment namespace
- **label:** "Resume rollout of {name}"

### Rollout (Ask Claude)
- **kind:** `rollout` (executable; does NOT open confirm sheet in Swift, but web MUST open ConfirmSheet)
- **kubectl:** (N/A — this is instructional; execution details deferred)
- **name:** deployment name
- **namespace:** deployment namespace
- **label:** "Show rollout status"

All actions **MUST** pass through `ConfirmSheet` showing the exact kubectl command before execution (except chat handoffs, which are prose-only).

---

## 5. DEFERRED (Not Built in Phase A)

### Management Sheet
The Swift `DeploymentManageSheet` is a detail view showing:
- Inline scale control (stepper + "Apply scale" button)
- Restart / Pause-Resume / Rollback buttons
- Live `kubectl describe deployment` output (long tail of conditions, events, rollout history)

**For web Phase A:** Skip management sheet; use inline row actions + ConfirmSheet.

### Move-to-Namespace Dialog
The Swift `DeploymentMoveSheet` allows moving a deployment to another namespace. This requires:
- Helm-Helmsman chat handoff to discover related resources (services, configmaps, secrets, ingresses, PVCs)
- Series of apply/delete actions

**For web Phase A:** Skip this feature; it requires chat integration and complex resource discovery.

### Per-Container Metrics
The Swift app does not show live metrics in the list view, but the manage sheet may (if metrics-server is available). The web spec does NOT include metrics.

### Rollout History Detail
The Swift manage sheet shows `kubectl describe` which includes `OldReplicaSets` and condition details. For web Phase A, show only current status fields (`status.replicas`, `status.readyReplicas`, `status.updatedReplicas`, `status.availableReplicas`).

---

## 6. Search & Filtering

**Search scope:** Case-insensitive substring match against:
- Deployment name (`metadata.name`)
- Namespace (`metadata.namespace`)
- Image repository (full first-container image, without tag)

**Namespace scope:** Inherit from store's `namespaceFilter`:
- If `namespaceFilter === null` → show all namespaces
- If `namespaceFilter === "default"` → show only default namespace
- Subscribe with `subscribe('deployments', namespaceFilter ?? '*')`

---

## 7. Integration Points

### Zustand Store (`apps/web/src/store/cluster.ts`)
- **Read:** `useCluster((s) => s.resources['deployments'])` — object keyed by `metadata.uid`
- **Read:** `useCluster((s) => s.isLoading)` — loading state
- **Read:** `useCluster((s) => s.error)` — watch/connection error message
- **Read:** `useCluster((s) => s.namespaceFilter)` — active namespace scope

### WebSocket Subscribe (`apps/web/src/lib/ws.ts`)
- Call `subscribe('deployments', namespaceFilter ?? '*')` on mount
- Call `unsubscribe('deployments', ns)` on unmount
- **Return:** unsubscribe cleanup function

### ConfirmSheet (`apps/web/src/components/ConfirmSheet.tsx`)
- Pass `ActionBlock` (with `kind`, `name`, `namespace`, `replicas?`, `label`, `destructive?`)
- Show exact `kubectl` command via `fetchPreviewCommand(action)`
- On execute, send to server via `useAction()` → `POST /api/action`
- Close on success (auto, after 1.2s)
- Show error/result in sheet

### API Types (`apps/web/src/lib/api.ts`)
```typescript
export interface ActionBlock {
  kind: string;  // "restart" | "scale" | "rollback" | "pause" | "resume"
  label?: string;
  name?: string;  // deployment name
  namespace?: string;
  replicas?: number;  // scale only
  destructive?: boolean;
}
```

---

## 8. Type Definition (Web)

**File:** `apps/web/src/panels/deployments/types.ts`

```typescript
import type { ObjectMeta, Container, PodTemplate } from "@/lib/api";

export interface DeploymentSpec {
  replicas?: number;
  selector?: { matchLabels?: Record<string, string> };
  template?: PodTemplate;
  strategy?: {
    type?: string;
    rollingUpdate?: {
      maxSurge?: string | number;
      maxUnavailable?: string | number;
    };
  };
  paused?: boolean;
}

export interface DeploymentStatus {
  replicas?: number;
  readyReplicas?: number;
  availableReplicas?: number;
  updatedReplicas?: number;
}

export interface Deployment {
  metadata: ObjectMeta;
  spec?: DeploymentSpec;
  status?: DeploymentStatus;
}

export interface Container {
  name: string;
  image?: string;
  ports?: Array<{ containerPort: number }>;
  resources?: {
    requests?: Record<string, string>;
    limits?: Record<string, string>;
  };
}

export interface PodTemplate {
  spec?: { containers: Container[] };
}
```

---

## 9. Display Helper Functions (`apps/web/src/panels/deployments/deploymentDisplay.ts`)

```typescript
// Mirrors Swift Deployment helpers

export function relativeAge(iso: string | undefined): string
// "5s" / "3m" / "2h" / "1d" / "—"

export function statusColor(deployment: Deployment, pods: Pod[]): string
// Classname for name field color

export function readyText(deployment: Deployment): string
// "{readyReplicas}/{replicas}"

export function imageRepo(image: string | undefined): string
// "ghcr.io/foo/bar" (strip tag/digest)

export function imageTag(image: string | undefined): string
// "latest" / "v1.2.3" / "@abc123" (short digest)

export function containerSummaries(deployment: Deployment): ContainerSummary[]
// Array of {name, image, cpuReq, cpuLim, memReq, memLim, ports}

export function strategyDescription(deployment: Deployment): string
// "RollingUpdate · maxSurge 25% · maxUnavailable 25%"

export function selectorString(deployment: Deployment): string
// "app=web,tier=frontend" (sorted by key)

export function isRedeploying(deployment: Deployment): boolean
// desired > 0, no error pods, updated/ready != desired

export function rolloutProgress(deployment: Deployment): number
// 0…1 fraction (updatedReplicas / desired)

export function matchesSearch(deployment: Deployment, query: string): boolean
// Substring match on name, namespace, image repo

export function sortDeployments(deployments: Deployment[]): Deployment[]
// Sort by namespace, then name (stable for table)
```

---

## 10. Test Plan

### Unit Tests (`deploymentDisplay.test.ts` via vitest)
- `relativeAge()` edge cases (0s, now, past)
- Image parsing (tag extraction, digest short-form, missing tag → "latest")
- Color logic (error pods, scaled-to-zero, rolling, healthy)
- Search matching (case-insensitive, all fields)
- Sort order (namespace, then name)

### Integration Tests
- Panel subscription & unsubscribe on mount/unmount
- Namespace filter change triggers re-subscribe
- ConfirmSheet opens for each action kind
- Correct kubectl preview for restart, scale, rollback, pause, resume
- Empty state, loading state, error state display

### Acceptance
- [ ] Live deployments table from store; rows update on watch deltas
- [ ] Restart action opens ConfirmSheet showing `kubectl rollout restart deployment/…`
- [ ] Scale action prompts for replica count; ConfirmSheet shows `kubectl scale deployment/… --replicas=N`
- [ ] Rollback, Pause, Resume actions show correct kubectl in ConfirmSheet
- [ ] Search filters by name, namespace, image
- [ ] Expand row shows spec, pods, strategy, containers
- [ ] Namespace filter inherited from store; unsubscribe old, subscribe new
- [ ] Loading/error/empty states display correctly

---

## 11. Build Checklist

- [ ] Create `apps/web/src/panels/deployments/types.ts` with `Deployment`, `DeploymentSpec`, `DeploymentStatus` types
- [ ] Create `apps/web/src/panels/deployments/deploymentDisplay.ts` with helper functions (TDD'd with vitest)
- [ ] Create `apps/web/src/panels/deployments/deploymentDisplay.test.ts` with unit tests
- [ ] Create `apps/web/src/panels/deployments/DeploymentsPanel.tsx` (mirrors PodsPanel structure)
- [ ] Update `apps/web/src/App.tsx` — change `/deployments` from stub to `<DeploymentsPanel />`
- [ ] Verify `packages/k8s/src/watch.ts` and server already support `deployments` kind (should be no-op)
- [ ] Test: `pnpm --filter web typecheck`
- [ ] Test: `pnpm --filter web build`
- [ ] Test: `pnpm --filter web test`
- [ ] Test: `pnpm --filter @helmsman/server test`
- [ ] Manual verification: deployments table populates, actions show correct kubectl, namespace filter works

---

## 12. Reference Implementation Notes

This spec is derived from:
- `Sources/Helmsman/Panels/Deployments/DeploymentsPanel.swift` — main list view with row expansion
- `Sources/Helmsman/Panels/Deployments/DeploymentsViewModel.swift` — filtering, search, expansion state
- `Sources/Helmsman/Cluster/KubeTypes.swift` — Deployment, DeploymentSpec, DeploymentStatus structs
- `Sources/Helmsman/Cluster/WorkloadTypes.swift` — strategy and container helpers
- `Sources/Helmsman/Handoff/ResourceAction.swift` — DeploymentAction enum (Errors, Logs, Explain, Rollout)
- `docs/parity/contracts.md` — action-block protocol and kubectl command spec

The web port **reuses** existing infra:
- `apps/web/src/store/cluster.ts` — Zustand store, no changes needed
- `apps/web/src/components/ConfirmSheet.tsx` — confirm gate, no changes needed
- `apps/web/src/lib/api.ts` — ActionBlock type, already covers all deployment actions
- `apps/server/src/actions.ts` — buildCommand already handles restart/scale/rollback/pause/resume

**DO NOT:**
- Modify the server or packages/k8s (deployment watch + action kinds already work)
- Build metrics, rollout-history, or per-container live output
- Invent new action kinds or modify action-block schema
- Create new npm dependencies (use shadcn components only)
