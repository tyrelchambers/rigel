# Overview Panel — Normative Behavior Spec (Web Port)

**Status**: READ-ONLY dashboard; cluster-health-at-a-glance; no mutations or filtering.

## Principles

The Overview panel is the landing dashboard (index route `/` and `/overview` alias). It displays a fast, at-a-glance summary of cluster health — resource counts, deployment health, pod phases, warning events, and (when metrics are available) live CPU/memory usage and reclaimable memory.

All data is read-only and computed from live Zustand store subscriptions. The panel does NOT support namespace scoping — all cards aggregate cluster-wide. Metrics availability (metrics-server installed) gracefully degrades.

---

## 1. Resource Subscriptions & Lifecycle

### Subscribe on Mount
```
subscribe('nodes', '*')           // cluster-scoped: no namespace filter
subscribe('pods', '*')            // all namespaces (aggregated view)
subscribe('deployments', '*')     // all namespaces
subscribe('events', '*')          // all namespaces
subscribe('namespaces', '*')      // cluster-scoped
```

### Unsubscribe on Unmount
```
unsubscribe('nodes', '*')
unsubscribe('pods', '*')
unsubscribe('deployments', '*')
unsubscribe('events', '*')
unsubscribe('namespaces', '*')
```

### Load/Error States
- **Loading**: Show spinner on initial subscribe; hide once first snapshot arrives.
- **Error**: Display error message banner (if `useCluster((s) => s.error)` is non-null).
- **No data**: All counts → `0`; text fallbacks ("No warning events", "—" for metrics).

---

## 2. Layout & Cards (Top to Bottom)

### Header Row (Sticky/Fixed)
- **Left**: Title "Overview" + active context name (monospace badge, gray background).
- **Right (Deferred)**: "Purge an app" button (red, trash icon) — DO NOT IMPLEMENT; mark as deferred.
- **Right (Deferred)**: "Investigate cluster" button (primary, sparkles icon) — triggers chat handoff; not yet spec'd; mark as deferred.

**Decision**: Omit both buttons in the initial port. DO NOT render them.

---

### Gauges Row (Cluster Resource Usage)

Display when `metricsAvailable` (metrics-server installed + nodes have usage data).

**Three Columns**:

#### 1. Cluster CPU (Ring Gauge)
- **Title**: "Cluster CPU"
- **Icon**: `gauge.with.dots.needle.bottom.50percent` (or equivalent gauge icon)
- **Fraction**: `cpuUsed / cpuAllocatable` (clamped to [0,1])
- **Detail Text**: `"{used} / {allocatable}"` formatted via `formatCpu()`, e.g. `"4.5 / 16"` cores
- **Source**: `Viz.clusterResourceTotals(nodes, nodeMetrics)` → `ResourceTotals.cpuFraction` & `cpuUsed/cpuAllocatable`

#### 2. Cluster Memory (Ring Gauge)
- **Title**: "Cluster Memory"
- **Icon**: gauge (same as CPU)
- **Fraction**: `memUsed / memAllocatable` (clamped to [0,1])
- **Detail Text**: `"{used} / {allocatable}"` formatted via `formatBytes()`, e.g. `"8.2Gi / 32Gi"`
- **Source**: `Viz.clusterResourceTotals()` → `ResourceTotals.memFraction` & `memUsed/memAllocatable`

#### 3. Reclaimable Memory (Card)
- **Title**: "Reclaimable"
- **Icon**: `arrow.down.right.circle.fill` (or down-right trending icon)
- **Content**:
  - If `workloadCount > 0`: Show `"{bytes} across {count} workload(s)"` + description text.
  - If `workloadCount == 0`: Show `"— no data yet"` + description text pointing to Right-Sizing panel.
- **Source**: Compute from a synthetic `DatabasesViewModel.rightSizingResults` placeholder (or hardcode empty for MVP). **Note**: The right-sizing data is not yet wired to the web store; show `"— no data yet"` for now.

#### Metrics Unavailable Fallback
If metrics-server is unavailable (no usage data), replace all three gauges with a single card:
- **Title**: "Cluster Usage"
- **Icon**: gauge icon
- **Content**: `"metrics-server unavailable — install it to see live CPU/memory usage."`
- **Text Color**: tertiary (muted)

---

### Top Row (Deployments | Pods | Nodes)

Three equal-width cards side-by-side.

#### Deployments Card
- **Title**: "Deployments"
- **Icon**: `square.stack.3d.up.fill` (box stack)
- **Metric** (big, monospace):
  - `{total}` — count of all deployments cluster-wide
  - Caption: `"deployment"` or `"deployments"` (plural)
- **Health Line**:
  - **Label**: "Unhealthy"
  - **Count**: number of deployments where `desired > 0 && ready < desired`
    ```
    desired = spec.replicas ?? status.replicas ?? 0
    ready = status.readyReplicas ?? 0
    unhealthy = desired > 0 && ready < desired ? 1 : 0
    ```
  - **Color**: red (failed/degraded status)

#### Pods Card
- **Title**: "Pods"
- **Icon**: `shippingbox.fill` (box)
- **Metric** (big):
  - `{total}` — count of all pods cluster-wide
  - Caption: `"pod"` or `"pods"`
- **Phase Breakdown** (three HealthLines):
  - **Running**: count of pods where `phase == "Running"` or `phase == "Succeeded"`; green.
  - **Pending**: count of pods where `phase == "Pending"`; yellow/orange.
  - **Failed**: count of pods where `phase == "Failed"`; red.

#### Nodes Card
- **Title**: "Nodes"
- **Icon**: `server.rack`
- **Metric** (big):
  - `{ready}/{total}` — ready nodes vs total nodes
  - `ready = count where status.conditions[type=="Ready"].status == "True"`
  - Caption: `"ready"`
- **Pressure Line**:
  - **Label**: "Pressure conditions"
  - **Count**: total active pressure conditions (DiskPressure, MemoryPressure, PIDPressure, NetworkUnavailable, etc.)
    ```
    pressureCount = sum over all nodes of:
      count(status.conditions where type != "Ready" && status == "True")
    ```
  - **Color**: yellow/orange (warning/pending status)

---

### Middle Row (Databases | Events Count)

Two equal-width cards.

#### Databases Card (Simple Placeholder)
- **Title**: "Databases"
- **Icon**: `cylinder.split.1x2.fill`
- **Metric** (big):
  - `{total}` — count of detected database instances (CNPG clusters + image-detected).
  - Caption: `"instance"` or `"instances"`
- **Health Line**:
  - **Label**: "Unhealthy"
  - **Count**: number of unhealthy instances (e.g. not all pods ready, or CNPG status != "ready").
  - **Color**: red

**MVP Note**: For the initial port, this is a stub. The Databases panel infra is complex (CNPG detection, image parsing, pod correlation). If no data available, show `0` instances and `0` unhealthy. Accept that this card will be updated when full Databases infra lands.

#### Events Count Card
- **Title**: "Events"
- **Icon**: `exclamationmark.bubble.fill`
- **Metric** (big):
  - `{warnings}` — count of events with `type == "Warning"`
  - Caption: `"warnings (last 500)"` (the store caches ~500 events)
- **Health Line**:
  - **Label**: "Total cached"
  - **Count**: total event count in the cache
  - **Color**: secondary/muted

---

### Event Timeline Card (Visual Ribbon)

- **Title**: "Event activity — last 1h"
- **Icon**: `waveform.path.ecg`
- **Subtitle Font**: small, uppercase, tracked
- **Chart**: Event timeline ribbon (histogram-style, stacked bar chart).
  - **Span**: 3600 seconds (1 hour)
  - **Buckets**: 60 equal slots (1 minute each)
  - **Data**: Computed via `eventBuckets(events, now=Date.now(), span=3600, count=60)`
  - **Colors**:
    - **Warnings**: red
    - **Normal**: green
  - **Interactive**: Display-only (no click/drill-down in this spec).

**Source**: All events, scoped to cluster-wide (not filtered by type or search).

---

### Recent Warnings Card (Event List)

- **Header**:
  - **Icon**: `exclamationmark.triangle.fill` (red)
  - **Title**: "Recent warnings"
  - **Divider**: subtle border below header
- **Content**:
  - If empty: `"No warning events."` (tertiary text, left-aligned, padded)
  - If populated: List of up to 10 most recent warning events (newest first)
    - **Columns** (left to right):
      1. **Red bar** (2px width, 12px height, left edge of row)
      2. **Reason** (monospace, 10pt, max 140px, single line, truncate)
      3. **Target** (`kind/name` or `kind/name · namespace`; monospace, 10pt, max 200px, single line, truncate middle)
      4. **Message** (monospace, 11pt, flex/grow, single line, truncate end)
      5. **Relative Age** (monospace, 10pt, right-aligned, fixed 36px, e.g. `"5m"`)
         - **Tooltip**: Absolute timestamp (e.g. `"Jun 1, 2026, 8:14:02 AM"`)
    - **Row padding**: 6px horiz, 3px vert
    - **List spacing**: 1px between rows (tight)

---

## 3. Helper Functions & Aggregations

All pure functions; must be unit-tested via vitest.

### Pod Phase Breakdown

```typescript
interface PhaseCounts {
  running: number;   // "Running" + "Succeeded"
  pending: number;   // "Pending"
  failed: number;    // "Failed"
  other: number;     // all others
}

function phaseCounts(pods: Pod[]): PhaseCounts {
  const result: PhaseCounts = { running: 0, pending: 0, failed: 0, other: 0 };
  for (const p of pods) {
    switch (p.status?.phase) {
      case "Running":
      case "Succeeded":
        result.running++;
        break;
      case "Pending":
        result.pending++;
        break;
      case "Failed":
        result.failed++;
        break;
      default:
        result.other++;
    }
  }
  return result;
}
```

### Deployment Health

```typescript
function isHealthy(d: Deployment): boolean {
  const ready = d.status?.readyReplicas ?? 0;
  const desired = d.spec?.replicas ?? d.status?.replicas ?? 0;
  return desired === 0 || ready >= desired;
}
```

### Node Ready Count

```typescript
function nodeReadyCount(nodes: Node[]): { ready: number; total: number } {
  const total = nodes.length;
  const ready = nodes.filter((n) => {
    const cond = n.status?.conditions?.find((c) => c.type === "Ready");
    return cond?.status === "True";
  }).length;
  return { ready, total };
}
```

### Node Pressure Count

```typescript
function nodePressureCount(nodes: Node[]): number {
  let count = 0;
  for (const n of nodes) {
    count += (n.status?.conditions ?? []).filter(
      (c) => c.type !== "Ready" && c.status === "True"
    ).length;
  }
  return count;
}
```

### Format CPU Cores

```typescript
function formatCpu(cores: number): string {
  if (cores === 0) return "0";
  if (cores < 1) return `${(cores * 1000).toFixed(0)}m`;
  return cores.toFixed(1);
}
```

### Format Memory (Binary)

```typescript
function formatBytes(quantity: string | undefined): string {
  if (!quantity) return "—";
  const match = /^(\d+(?:\.\d+)?)([A-Za-z]+)?$/.exec(quantity.trim());
  if (!match) return "—";
  
  const value = Number(match[1]);
  if (Number.isNaN(value)) return "—";
  
  const suffix = match[2];
  const factors: Record<string, number> = {
    Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60,
  };
  
  let bytes = !suffix ? value : (factors[suffix] ?? -1) * value;
  if (bytes < 0) return "—";
  
  for (const [unit, factor] of Object.entries(factors).sort((a, b) => b[1] - a[1])) {
    if (bytes >= factor) {
      const n = bytes / factor;
      const rounded = Number.isInteger(n) ? n : Math.round(n * 10) / 10;
      return `${rounded}${unit}`;
    }
  }
  return `${bytes}`;
}
```

### Cluster Resource Totals

```typescript
interface ResourceTotals {
  cpuUsed: number;           // cores
  cpuAllocatable: number;
  memUsed: number;           // bytes
  memAllocatable: number;
  cpuFraction: () => number; // [0, 1]
  memFraction: () => number;
}

function clusterResourceTotals(
  nodes: Node[],
  nodeMetrics: Record<string, NodeMetrics>
): ResourceTotals {
  let cpuUsed = 0, cpuAllocatable = 0, memUsed = 0, memAllocatable = 0;
  
  for (const node of nodes) {
    const cap = node.status?.capacity ?? {};
    const alloc = node.status?.allocatable ?? {};
    
    const cpuKey = alloc.cpu ?? cap.cpu;
    if (cpuKey) cpuAllocatable += parseCpuQuantity(cpuKey);
    
    const memKey = alloc.memory ?? cap.memory;
    if (memKey) memAllocatable += parseMemQuantity(memKey);
    
    const m = nodeMetrics[node.metadata.name];
    if (m) {
      cpuUsed += parseCpuQuantity(m.usage.cpu ?? "0");
      memUsed += parseMemQuantity(m.usage.memory ?? "0");
    }
  }
  
  return {
    cpuUsed,
    cpuAllocatable,
    memUsed,
    memAllocatable,
    cpuFraction: () => cpuAllocatable > 0 ? Math.min(cpuUsed / cpuAllocatable, 1) : 0,
    memFraction: () => memAllocatable > 0 ? Math.min(memUsed / memAllocatable, 1) : 0,
  };
}
```

---

## 4. Rendering Constraints

### Card Structure
- **Use shadcn `Card`** (if available in the project) or a simple `<div className="border rounded-lg p-4">`.
- **Title header**: Icon + uppercase title + tracking.
- **Content**: Metric rows and health lines.
- **Spacing**: 12–14px padding, 1px border (subtle), rounded corners (lg radius).

### Colors (Tailwind Classes)
- **Running/Success**: `text-green-600 bg-green-600/15`
- **Pending/Warning**: `text-yellow-600 bg-yellow-600/15`
- **Failed/Degraded**: `text-red-600 bg-red-600/15`
- **Tertiary/Muted**: `text-muted-foreground`
- **Accent**: `text-accent` (primary blue)

### Responsive Layout
- **Gauges Row**: 3 columns; wrap to 2 at breakpoints if needed (but aim for horizontal).
- **Top Row**: 3 equal-width cards; flex.
- **Middle Row**: 2 equal-width cards; flex.
- **Timeline**: Full width.
- **Warnings**: Full width.

### Scrollable Container
- Wrap entire panel in `<ScrollView>` or `overflow-auto` div for vertical scroll.
- No horizontal scroll.

---

## 5. User Actions & Events

### No Mutations
The Overview panel is **read-only**. No buttons, context menus, or dialogs are implemented in the first port.

### Deferred: Purge Button
- The Swift panel renders a "Purge an app" button (red, trash icon).
- **Status**: DO NOT IMPLEMENT in the initial web port.
- **Reason**: Purge is a complex multi-resource deletion flow; requires its own panel + confirm sheet spec.
- **Marker**: `// TODO: Purge flow (deferred, see docs/parity/purge.md when available)`

### Deferred: Investigate Button
- The Swift panel renders an "Investigate cluster" button (primary, sparkles icon).
- **Status**: DO NOT IMPLEMENT.
- **Reason**: Requires chat integration + Claude handoff; spec TBD.
- **Marker**: `// TODO: Investigate handoff (deferred, see docs/parity/chat-overview.md when available)`

### Deferred: Event Drilldown
- The timeline ribbon is display-only in the first port.
- **Status**: No click handlers, no modal.

---

## 6. Empty States

### No Nodes
- Node cards show: `0/0 ready`, `0 pressure conditions`

### No Deployments
- Deployment card shows: `0 deployments`, `0 unhealthy`

### No Pods
- Pod card shows: `0 pods`, `0 running`, `0 pending`, `0 failed`

### No Events
- Events card shows: `0 warnings`, `0 total`
- Warnings list shows: `"No warning events."`

### No Metrics
- All three gauges replaced with fallback card: `"metrics-server unavailable…"`

---

## 7. Kubectl Commands (Reference, Read-Only)

All data originates from live WebSocket watch streams. No kubectl commands are issued from the Overview panel itself.

For reference, the **server** runs:
```bash
kubectl get nodes --watch -o json
kubectl get pods --watch -o json
kubectl get deployments --watch -o json
kubectl get events --watch -o json
kubectl get namespaces --watch -o json
kubectl get --raw /apis/metrics.k8s.io/v1beta1/nodes  # (or watch if supported)
```

---

## 8. Test Plan (Vitest)

### Unit Tests

#### Phase Breakdown
- Empty array → all zeros
- Mixed phases → correct counts
- "Succeeded" counted as "running"

#### Deployment Health
- `desired=0` → healthy (even if `ready=0`)
- `ready==desired` → healthy
- `ready<desired && desired>0` → unhealthy
- Missing `status.replicas` → use 0

#### Node Ready
- All ready → `{ready: n, total: n}`
- Some ready → correct split
- No conditions → not ready

#### Node Pressure
- Node with only "Ready" condition → 0 pressure
- Node with "DiskPressure" (True) → 1 pressure
- Node with multiple pressure conditions → sum all

#### Format Bytes
- `"8192Mi"` → `"8Gi"`
- `"1024Ki"` → `"1Mi"`
- `"0"` → `"0"`
- `undefined` → `"—"`
- Invalid format → `"—"`

#### Cluster Resource Totals
- Empty nodes → `{cpuAllocatable: 0, memAllocatable: 0, …}`
- Nodes without metrics → `cpuUsed=0, memUsed=0` (fallback to 0)
- With metrics → sum correctly
- `cpuFraction` and `memFraction` clamped to [0, 1]

#### Event Buckets (reuse from EventsPanel)
- Test via `eventsDisplay.eventBuckets()` (already exist)

### Integration Tests

#### Store Subscription
- On mount: subscribe called for 5 kinds
- On unmount: unsubscribe called for all 5 kinds
- Namespace filter ignored (always `"*"`)

#### Re-renders on Store Change
- Pod count updates → card re-renders
- Event added → warnings list updates
- Node condition change → pressure count updates

#### Metrics Availability
- No metrics → fallback card rendered
- Metrics present → gauges rendered with usage

---

## 9. File Structure (Web)

```
apps/web/src/panels/overview/
  ├── OverviewPanel.tsx          # Main component; subscribe/unsubscribe; render layout
  ├── overviewDisplay.ts         # Pure aggregation helpers (tested)
  ├── overviewDisplay.test.ts    # Vitest suite
  └── types.ts                   # Local types (if any; mostly reuse from other panels)
```

---

## 10. Integration Points

### Zustand Store (`useCluster`)
- `resources['nodes']` → Node[]
- `resources['pods']` → Pod[]
- `resources['deployments']` → Deployment[]
- `resources['events']` → K8sEvent[]
- `resources['namespaces']` → Namespace[]
- `isLoading` → boolean (show spinner on initial subscribe)
- `error` → string | null (show banner)

### WebSocket (`subscribe`/`unsubscribe`)
- No namespace filter (always `"*"`).
- Called in `useEffect` with dependency `[]` (mount/unmount only).

### Router (React Router v7)
- Route `"/"` → render `<OverviewPanel />`
- Route `"/overview"` → render `<OverviewPanel />` (alias)
- Navigation item: "overview" in the sidebar (case-sensitive or "Overview")

### App.tsx Integration
```typescript
import OverviewPanel from "./panels/overview/OverviewPanel";

// In PANELS array
const PANELS = ["overview", "pods", "deployments", ...];

// In Routes
<Route path="/" element={<div className="h-full overflow-auto p-4"><OverviewPanel /></div>} />
<Route path="/overview" element={<div className="h-full overflow-auto p-4"><OverviewPanel /></div>} />
```

---

## 11. Acceptance Criteria

1. **OverviewPanel.tsx** exists at `/apps/web/src/panels/overview/OverviewPanel.tsx`.
2. **overviewDisplay.ts** exists with pure functions (tested).
3. **All six summary cards render**:
   - Deployments (count + unhealthy)
   - Pods (count + running/pending/failed breakdown)
   - Nodes (ready/total + pressure)
   - Databases (count + unhealthy; MVP stub = 0/0)
   - Events (warnings + total)
   - Optional: Gauges (CPU/Memory/Reclaimable)
4. **Event timeline renders** (1h, 60 buckets, stacked warnings/normal).
5. **Recent warnings list renders** (up to 10, newest first, 5 columns).
6. **No mutations**: No buttons, ConfirmSheets, or action dispatches.
7. **Routes**: `"/"` and `"/overview"` both render `OverviewPanel`.
8. **Tests pass**: `pnpm --filter web test` (vitest).
9. **Type-safe**: `pnpm --filter web typecheck` passes.
10. **Builds**: `pnpm --filter web build` succeeds.

---

## 12. Deferred Features

| Feature | Reason |
|---------|--------|
| "Purge an app" button | Complex multi-resource deletion; requires separate spec & panel. |
| "Investigate cluster" button | Requires chat integration & Claude handoff spec. |
| Event timeline click/drill-down | Display-only in MVP. |
| Right-sizing reclaimable card | Requires full Right-Sizing panel infrastructure (not yet ported). |
| Full Databases card | Requires CNPG detection, image parsing, pod correlation (complex). |
| Namespace-scoped aggregations | Overview is always cluster-wide; no namespace filter. |
| Custom time windows | Timeline is hard-coded to 1h / 60 buckets. |

---

## 13. Notes

- **No new npm dependencies** beyond shadcn components (add card via `pnpm dlx shadcn add card` if needed).
- **Reuse existing display helpers** where possible (e.g., `relativeAge`, `phaseColorClass` from pods/events).
- **All aggregations must be pure** and testable.
- **Metrics are optional**: Graceful fallback if `metrics-server` is absent.
- **Swift source of truth**: Cross-check all card computations against `Sources/Helmsman/Panels/Overview/OverviewPanel.swift` and `Sources/Helmsman/Charts/Aggregations.swift`.

