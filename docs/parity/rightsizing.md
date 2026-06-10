# Right-Sizing Panel — Normative Behavior Spec

## Overview
The Right-Sizing panel analyzes Kubernetes workload resource requests/limits against observed CPU and memory usage to identify over-provisioning, under-provisioning (at-risk), and unset resource constraints. It sources historical usage data either from the app's local SQLite store (rolling 30-day window, sampled from `kubectl top pods` while the app runs) or from an external Prometheus-compatible endpoint (Prometheus, VictoriaMetrics). Verdicts and suggested requests/limits are computed deterministically from observed usage with configurable headroom factors.

## Resource Kinds Watched
- **Deployments** — reads `.spec.template.spec.containers[*].resources.{requests,limits}` and pods matching `name-*` pattern
- **StatefulSets** — reads `.spec.template.spec.containers[*].resources.{requests,limits}` and pods matching `name-*` pattern
- **DaemonSets** — reads `.spec.template.spec.containers[*].resources.{requests,limits}` and pods matching `name-*` pattern

## Data Sources & Metrics Collection

### Local SQLite Backend (Default)
- **Store**: `$HOME/Library/Application Support/Helmsman/metrics/metrics-<context>.sqlite` (macOS; generalizable to XDG_DATA_HOME or equivalent)
- **Polling**: App polls `kubectl get --raw /apis/metrics.k8s.io/v1beta1/pods?limit=500` every ~5-10s (or configurable interval)
- **Parser**: Decodes `PodMetricsList` JSON (Kubernetes Metrics Server API)
- **Ingestion**: `MetricsCollector` accumulates per-(workload, container) CPU/memory samples for the current hour, emitting completed hourly `MetricsBucket` rows when hour boundary is crossed
- **Aggregation**: `MetricsStore.aggregate(namespace, kind, name)` returns per-container `WindowStats` by reading the retained hourly buckets and computing:
  - `cpuPeak`: `MAX(cpuMax)` across all hourly buckets
  - `cpuTypical`: `AVG(cpuP95)` across all hourly buckets
  - `memPeak`: `MAX(memMax)` across all hourly buckets
  - `memTypical`: `AVG(memP95)` across all hourly buckets
  - `hoursCovered`: `COUNT(*)` of hourly buckets (row count)
- **Retention**: 30 days (rows older than 30 days are swept automatically)

### Prometheus Backend (Optional)
- **Detection**: Auto-detected by matching service names (contains "prometheus", "victoria", etc.) and well-known ports (9090 for Prometheus, 8428/8481 for VictoriaMetrics)
- **Querying**: Instant queries over a 30-day window via the Kubernetes API server proxy (`/api/v1/namespaces/<ns>/services/<svc>:<port>/proxy/api/v1/query`)
- **PromQL Queries** (per-workload, over 30 days):
  - `cpuPeak` = `max by (container) (max_over_time(rate(container_cpu_usage_seconds_total{namespace="<ns>",pod=~"<name>-.*",container!="",container!="POD"}[5m])[30d:5m]))`
  - `cpuTypical` = `max by (container) (quantile_over_time(0.95, rate(container_cpu_usage_seconds_total{...}[5m])[30d:5m]))`
  - `memPeak` = `max by (container) (max_over_time(container_memory_working_set_bytes{...}[30d]))`
  - `memTypical` = `max by (container) (quantile_over_time(0.95, container_memory_working_set_bytes{...}[30d]))`
  - `hoursCovered` = estimated from sample count × scrape interval
- **Fallback**: If Prometheus is unavailable, queries return empty maps; the panel shows "Metrics unavailable"

---

## Analysis Engine — `RightSizing.analyze(current, stats)`

**Inputs**:
- `current`: `ContainerResources` — parsed container spec (cpuRequest/Limit, memRequest/Limit as `Double` or `nil`)
- `stats`: `WindowStats` — aggregated historical usage (cpuPeak, cpuTypical, memPeak, memTypical, hoursCovered)

**Constants**:
```
minHours = 24                     // insufficient data below this
cpuLimitHeadroom = 1.5            // limits = peak × this (generous burst room for CPU)
memLimitHeadroom = 1.2            // limits = peak × this (modest OOM cushion for memory)
atRiskMemFraction = 0.9           // peak ≥ 90% of mem limit → risk
atRiskCpuFraction = 0.95          // peak ≥ 95% of cpu limit → throttling
overMemRatio = 2.0                // request > 2× typical → wasteful
overCpuRatio = 3.0                // request > 3× typical → wasteful
minMemSlack = 128 MiB             // ignore < 128 MiB reclaimable
minCpuSlack = 100m                // ignore < 100m reclaimable
```

**Verdict Logic** (first matching rule wins):
1. **Insufficient Data** (if `hoursCovered < minHours`):
   - Verdict: `insufficientData`
   - Rationale: `"Only Xh of history (need 24h)."`
   - Suggested values: `nil` (no suggestion shown)

2. **At Risk** (if `stats.memPeak ≥ memLimit × 0.9` OR `stats.cpuPeak ≥ cpuLimit × 0.95`):
   - Verdict: `atRisk`
   - Rationale: "Peak memory is within 10% of the limit — OOM risk." OR "Peak CPU is at the limit — likely throttling."
   - Suggested requests: `max(cpuTypical, 0.01)` cores, `max(memTypical, 1)` bytes
   - Suggested limits: `max(cpuPeak × 1.5, cpuRequest)` cores, `max(memPeak × 1.2, memRequest)` bytes

3. **Unset** (if any of cpuRequest, cpuLimit, memRequest, memLimit is `nil`):
   - Verdict: `unset`
   - Rationale: "Missing requests and/or limits — the scheduler can't bin-pack or protect this container."
   - Suggested requests/limits: same as above

4. **Over-Provisioned** (if `(memRequest > memTypical × 2.0 AND memRequest - memTypical > 128 MiB)` OR `(cpuRequest > cpuTypical × 3.0 AND cpuRequest - cpuTypical > 100m)`):
   - Verdict: `overProvisioned`
   - Rationale: "Requests are well above real usage — capacity is being reserved but not used."
   - Suggested requests/limits: same as above

5. **OK** (all others):
   - Verdict: `ok`
   - Rationale: "Requests and limits track observed usage."
   - Suggested requests/limits: same as above

---

## UI Components & Data Flow

### Panel Header
- **Title**: "Right-sizing"
- **Count badge**: `filtered.length` workloads
- **Backend picker**: Menu showing "Local history" (always) + auto-detected Prometheus backends + "Set up a metrics backend…" (opens install sheet)
- **Refresh button**: Manual re-analyze (clears the 2-minute freshness cache)
- **Progress spinner**: Shows while analysis is in progress

### Control Bar (below header)
- **Sort pills**: "Needs attention" (at-risk + unset first, then wasteful), "Most wasteful" (by reclaimable memory), "Name" (ns/name)
- **Search field**: Filter by workload name or namespace

### Content States

#### Warming Up (isWarmingUp = true)
Shows an info banner:
```
[Hourglass icon] Collecting usage history — recommendations need ~24h of data
[Detail message: backend-specific, e.g. "Reading from Prometheus (kube-monitoring/prometheus:9090), which scrapes continuously — but it still needs ~24h of history built up. So far: Xh of 24h. Verdicts appear automatically once there's enough."]
```
The list still renders below, but all verdicts read "Gathering data" and `hoursCovered < minHours`.

#### Empty (filtered.isEmpty)
Shows a centered message:
```
[Gauge icon]
"No workloads to analyze yet" (or "Analyzing…" if isAnalyzing)
"Usage history builds hourly; confident verdicts need ~24h of data."
```

#### Workload Row (collapsed view)
**Fields** (left to right):
- Chevron (expand/collapse toggle)
- Kind badge: "DEP", "STS", "DS" (uppercase, monospace, accent color)
- Workload name (monospace, max 1 line)
- Namespace (monospace, smaller, tertiary color)
- **Worst verdict badge** (color-coded per verdict):
  - `ok` → green
  - `overProvisioned` → amber
  - `atRisk` → red
  - `unset` → red
  - `insufficientData` → tertiary gray
- Reclaimable memory (if > 0): "reclaim ~<formatted>" in amber
- Spacer
- (No actions in collapsed view)

**Button action**: Click to toggle expanded view

#### Container Detail (expanded view, per container in workload)
**Header**:
- Container name (monospace, medium)
- Verdict badge (color-coded)
- "Xh history" or "Xh/24h" (if insufficient data) (tertiary, monospace)

**Rationale**:
- Free text paragraph explaining the verdict (secondary color)

**Suggestion Table** (if `hasSuggestion = true`; shown when verdict ≠ insufficientData):
- Grid with columns: [label | current req/lim | arrow | recommended req/lim | observed peak/typical]
- Two rows: "CPU" and "MEM"
- **CPU row**:
  - Current: `<format(cpuRequest)> / <format(cpuLimit)>` (or "(unset)" if nil)
  - Recommended: `<format(suggestedCpuRequest)> / <format(suggestedCpuLimit)>`
  - Observed: "peak <format(cpuPeak)> · typ <format(cpuTypical)>"
- **MEM row**:
  - Current: `<format(memRequest)> / <format(memLimit)>` (or "(unset)" if nil)
  - Recommended: `<format(suggestedMemRequest)> / <format(suggestedMemLimit)>`
  - Observed: "peak <format(memPeak)> · typ <format(memTypical)>"

**Action Buttons** (bottom right, if suggestion is present):
- **Copy**: Copies a YAML snippet to clipboard:
  ```yaml
  resources:
    requests:
      cpu: <suggested-cpu-request-quantity>
      memory: <suggested-mem-request-quantity>
    limits:
      cpu: <suggested-cpu-limit-quantity>
      memory: <suggested-mem-limit-quantity>
  ```
- **Ask Claude**: Opens chat with the workload context (handoff for discussion/review)
- **Apply**: Opens confirm sheet with a `setResources` action block and runs it if confirmed

---

## Formatting & Display

### Quantity Formatting

**CPU cores to string** (for display):
- If < 1 core: display as "Xm" (millicores, e.g. "250m")
- If ≥ 1 and < 10: display with 2 decimals (e.g. "2.50")
- If ≥ 10: display as integer (e.g. "4")

**Memory bytes to string** (for display):
- Use binary suffixes (KiB, MiB, GiB, TiB)
- Show 1 decimal if < 10 units (e.g. "1.5 GiB")
- Show 0 decimals if ≥ 10 units (e.g. "256 MiB")

**Quantity parsing** (from k8s manifests):
- CPU: parse "1500m" → 1.5 cores, "4" → 4.0 cores, etc.
- Memory: parse "512Mi" → 536870912 bytes, "1Gi" → 1073741824 bytes, etc.

**Quantity string generation** (for `kubectl set resources`):
- CPU: round up to nearest 10m, collapse to whole cores (e.g. 0.25 → "250m", 2.0 → "2")
- Memory: round up to nearest MiB, collapse to GiB (e.g. 320 MiB → "320Mi", 2 GiB → "2Gi")

---

## Sorting

**Needs attention** (default):
1. All at-risk containers first
2. Then unset
3. Then over-provisioned
4. Then ok
5. Then insufficient-data
6. Within each tier: alphabetical by namespace, then name

**Most wasteful**:
- Sorted by `reclaimableMemBytes` descending (sum of `memRequest - suggestedMemRequest` for over-provisioned containers)

**Name**:
- Alphabetical by namespace, then workload name

---

## User Actions

### Refresh (manual)
**Button**: Refresh icon in header
**Action**: Call `refresh(force: true)` on the view model, clearing the 2-minute freshness cache
**Effect**: Re-queries the metrics backend (local or Prometheus) and recomputes all verdicts

### Backend Switch
**UI**: Dropdown menu ("Local" or "Prometheus …")
**Action**: Select a different metrics source
**Effect**: Persists the choice per kube-context, clears the freshness cache, and refreshes

### Copy Suggestion
**Button**: "Copy" under container detail
**Action**: Copy the YAML resource snippet to clipboard (no kubectl involved)
**Effect**: User can paste into their manifest editor

### Ask Claude
**Button**: "Ask Claude" under container detail
**Action**: Handoff to the chat panel with workload context
**Effect**: Switches to chat and seeds a message with the workload name + verdict

### Apply Suggestion
**Button**: "Apply" under container detail
**Action**:
1. Generate a `setResources` action block:
   ```json
   {
     "kind": "setResources",
     "name": "<workload-name>",
     "namespace": "<namespace>",
     "container": "<container-name>",
     "requests": "cpu=<suggested-cpu-request-quantity>,memory=<suggested-mem-request-quantity>",
     "limits": "cpu=<suggested-cpu-limit-quantity>,memory=<suggested-mem-limit-quantity>"
   }
   ```
2. Opens a confirm sheet showing the exact kubectl command:
   ```bash
   kubectl --context <ctx> set resources <kind>/<name> \
     -c <container> \
     --requests=cpu=<...>,memory=<...> \
     --limits=cpu=<...>,memory=<...> \
     -n <namespace>
   ```
3. On confirmation: executes the action and refreshes the panel

### Install Metrics Backend
**Button**: "Set up a metrics backend…" in the backend picker
**Action**: Opens a sheet to install Prometheus or VictoriaMetrics
**Effect**: (Implementation deferred; see constraints)

---

## Metrics Unavailable State

If metrics-server is not installed or queries fail:
- Local backend: Returns `[workloads with no usage data]` — every verdict reads "Gathering data"
- Prometheus backend: Queries fail silently; renders "Metrics unavailable — install metrics-server to see right-sizing"
- **No HTTP 500 errors**: Graceful degradation. Always HTTP 200 with `{ available: false, items: [] }` when metrics API is absent.

---

## Implementation Contract (Web Port)

### Server-Side (`apps/server`)

#### REST Endpoints

**GET `/api/metrics/pods`**
- Query params: `namespace=<ns|*>` (default `*` = all namespaces)
- Returns: `{ available: boolean, items: Array<PodMetrics> }`
  - `available = true` if metrics-server is installed
  - `items` = parsed output of `kubectl top pods [--all-namespaces|-n ns] --no-headers`
- Format of each item:
  ```json
  {
    "namespace": "default",
    "name": "nginx-abc123",
    "cpu": "150",
    "memory": "32Mi"
  }
  ```
  - `cpu`: numeric string, in millicores
  - `memory`: numeric string, in Mi (binary mebibytes)
- If metrics-server is absent: returns HTTP 200 with `{ available: false, items: [] }` (no 500 error)
- Parsing module: `apps/server/src/metrics.ts` with testable `parseKubectlTop()` function

**GET `/api/metrics/nodes`**
- Query params: none
- Returns: `{ available: boolean, items: Array<NodeMetrics> }`
- Format of each item:
  ```json
  {
    "name": "node-1",
    "cpu": "1200",
    "memory": "4096Mi"
  }
  ```
- Parsing: Similar to pods
- If metrics-server is absent: returns HTTP 200 with `{ available: false, items: [] }`

#### Implementation Details
- Both endpoints run `kubectl top [pods|nodes] --no-headers` and parse the columnar output
- **Parsing**: Extract namespace (if present), pod/node name, CPU (in millicores), and memory (in Mi)
- **Module**: `apps/server/src/metrics.ts` exports:
  - `parseKubectlTopLine(line: string): PodMetricRow | null` — parses one line of `kubectl top pods --all-namespaces --no-headers`
  - `normalizeQuantity(value: string, unit: 'cpu' | 'memory'): number` — converts "150m" or "32Mi" to numeric millicores or bytes
- **Error handling**: If `kubectl top` exits non-zero (metrics-server not installed), catch the error, log it, and return `{ available: false, items: [] }` (HTTP 200)
- **Tests**: Unit tests in `apps/server/src/metrics.test.ts` covering:
  - Parsing `kubectl top pods --all-namespaces --no-headers` output
  - CPU/memory quantity normalization
  - Error cases (metrics-server absent, malformed lines)

### Client-Side (`apps/web`)

#### Panel Component (`apps/web/src/panels/rightsizing/RightSizingPanel.tsx`)
- Renders the full right-sizing UI as described above
- Uses **TanStack Query** to poll `/api/metrics/pods?namespace=<active-ns|*>` with a 15s refetch interval
- Reads workload specs (Deployments, StatefulSets, DaemonSets) from the **Zustand cluster store** (`useClusterStore()`)
- Computes verdicts and suggestions via the analysis functions in `displayHelper.ts`
- Shows "Metrics unavailable" if `available: false`

#### Display Helper (`apps/web/src/panels/rightsizing/displayHelper.ts`)
- Exports pure functions (no I/O):
  - `analyzeContainer(current: ContainerResources, stats: WindowStats): RightSizingResult` — implements the verdict logic verbatim from Swift
  - `formatCpuCores(cores: number): string` — display formatting
  - `formatMemBytes(bytes: number): string` — display formatting
  - `parseQuantity(value: string, type: 'cpu' | 'memory'): number` — parses k8s quantity strings
  - `quantityToString(value: number, type: 'cpu' | 'memory'): string` — emits kubectl-valid strings
- **Tests**: `apps/web/src/panels/rightsizing/displayHelper.test.ts` covering:
  - Quantity parsing/formatting (CPU cores, memory bytes)
  - Verdict logic for each case (at-risk, unset, over-provisioned, ok, insufficient-data)
  - Reclaimable memory computation
  - Sorting (needs-attention, wasteful, name)

#### Types (`apps/web/src/panels/rightsizing/types.ts`)
```typescript
interface ContainerResources {
  container: string;
  cpuRequest?: number;  // cores or undefined
  cpuLimit?: number;
  memRequest?: number;  // bytes or undefined
  memLimit?: number;
}

interface WindowStats {
  container: string;
  cpuPeak: number;
  cpuTypical: number;
  memPeak: number;
  memTypical: number;
  hoursCovered: number;
}

interface RightSizingResult {
  container: string;
  verdict: Verdict; // "ok" | "overProvisioned" | "atRisk" | "unset" | "insufficientData"
  hoursCovered: number;
  cpuPeak: number;
  cpuTypical: number;
  memPeak: number;
  memTypical: number;
  cpuRequest?: number;
  cpuLimit?: number;
  memRequest?: number;
  memLimit?: number;
  suggestedCpuRequest?: number;
  suggestedCpuLimit?: number;
  suggestedMemRequest?: number;
  suggestedMemLimit?: number;
  rationale: string;
}

interface WorkloadRightSizing {
  kind: "deployment" | "statefulset" | "daemonset";
  name: string;
  namespace: string;
  containers: RightSizingResult[];
  worst: Verdict;  // most urgent verdict across containers
  reclaimableMemBytes: number;
}
```

#### Integration (App.tsx)
- Add `"rightsizing"` to the PANELS array
- Add route and import: `<Route path="/rightsizing" element={<div className="h-full overflow-auto p-4"><RightSizingPanel /></div>} />`

---

## Constraints

- **No new npm dependencies** (beyond shadcn/ui which is pre-approved)
- **No 500 errors** when metrics-server is absent; always graceful degradation
- **Keep existing routes/WS intact**: Don't break chat, logs, watch streams, or other panels
- **Pure analysis functions**: All verdict/formatting logic is side-effect-free and testable
- **Store-driven workload lookup**: Don't fetch workloads from kubectl in the panel; read from Zustand store
- **Action blocks only**: Mutations go through the confirm sheet (via `setResources` action-block kind)

---

## Acceptance Criteria

1. **Server metrics endpoints** exist and return valid JSON:
   - `GET /api/metrics/pods?namespace=*` returns `{ available: true, items: [...] }`
   - `GET /api/metrics/nodes` returns `{ available: true, items: [...] }`
   - No 500 errors; graceful HTTP 200 with `available: false` if metrics-server is absent

2. **Panel polls and displays**:
   - Polls `/api/metrics/pods` every ~15s
   - Reads workload specs from the cluster store
   - Renders one row per workload with kind, name, namespace, worst verdict, reclaimable memory
   - Expands to show per-container suggestions (CPU/mem current vs. recommended vs. observed)

3. **Sorting and filtering** work:
   - "Needs attention" sorts at-risk + unset first, then wasteful
   - "Most wasteful" sorts by reclaimable memory
   - "Name" sorts alphabetically
   - Search filters by workload name or namespace

4. **Verdicts are correct**:
   - `at-risk`: memory peak ≥ 90% of limit, or CPU peak ≥ 95% of limit
   - `unset`: any of cpuReq, cpuLim, memReq, memLim is missing
   - `overProvisioned`: requests > 2-3× typical usage (with slack thresholds)
   - `ok`: else
   - `insufficientData`: < 24 hours of history
   - Rationale strings are shown per container

5. **Suggestions are correct**:
   - Requests: `max(typical, min)`
   - Limits: `max(peak × headroom, request)`
   - Formatted as kubectl quantities (e.g., "250m", "512Mi")

6. **Actions work**:
   - Copy button copies YAML snippet
   - Ask Claude handoff opens chat
   - Apply button opens confirm sheet with exact kubectl command and executes on confirmation

7. **Graceful states**:
   - Empty: shows "No workloads to analyze yet"
   - Warming up: shows banner with collection progress
   - Metrics unavailable: shows friendly message, no 500 errors

8. **Tests pass**:
   - `pnpm --filter @helmsman/server test` (metrics parsing)
   - `pnpm --filter web test` (panel logic, display helpers, verdict math)
   - `pnpm --filter web typecheck` (no type errors)
   - `pnpm --filter web build` (production build succeeds)

