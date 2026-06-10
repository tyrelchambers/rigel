# Nodes Panel — Normative Web Port Spec

**Status**: SOURCE OF TRUTH for web implementation.  
**Extracted from**: `Sources/Helmsman/Panels/Nodes/NodesPanel.swift` + `NodesViewModel.swift`.  
**Watch scope**: cluster-scoped (all nodes); subscribe to `nodes` with namespace `*`.

---

## 1. Data Source

### Watch Subscription
- **Kind**: `nodes`
- **Namespace**: `*` (cluster-scoped; no namespace filter applies)
- **Initial snapshot**: Full node list from cluster cache
- **Deltas**: Added/updated/removed nodes trigger store updates
- **Ref**: `subscribe('nodes', '*')` + `resources['nodes']` in web store

### Resource Type
```typescript
interface Node {
  metadata: ObjectMeta;
  spec: NodeSpec;
  status: NodeStatus;
}
```

---

## 2. Display Columns & Field Mappings

Table view with one row per node, control-plane nodes sorted first (by role label), then by name (lexicographic).

### Column: Expand/Collapse
- **Type**: Toggle button (chevron right/down)
- **Data source**: Client state (expanded set)
- **Behavior**: Expands inline detail block below the row
- **Swift ref**: `NodeCard.isExpanded` + `toggleExpansion(_:)`

### Column: Name
- **Type**: Text (monospace)
- **Data source**: `metadata.name`
- **Click**: Toggles expand/collapse detail block
- **Sortable**: Primary sort (after role)

### Column: Status Pill
- **Type**: Badge/pill
- **Values**:
  - "Ready" (green) when `status.conditions[type=="Ready"].status == "True"`
  - "NotReady" (red) otherwise
- **Data source**: `isReady` computed property
- **Swift ref**: `Node.isReady` extension; `NodeCard.titleRow`

### Column: Role Badge
- **Type**: Badge/chip (uppercase monospace)
- **Values**:
  - "CONTROL-PLANE" (primary accent color) when:
    - `metadata.labels["node-role.kubernetes.io/control-plane"]` exists, OR
    - `metadata.labels["node-role.kubernetes.io/master"]` exists
  - "WORKER" (secondary color) otherwise (default)
- **Data source**: `Node.role` computed property
- **Swift ref**: `Node.role` extension; `RoleChip` view

### Column: Cordoned Badge
- **Type**: Badge/chip (uppercase monospace, pending/warning color)
- **Visibility**: Shown only when `spec.unschedulable == true`
- **Text**: "CORDONED"
- **Data source**: `spec.unschedulable` boolean
- **Swift ref**: `NodeCard.titleRow`, conditional "cordoned" badge

### Column: Actions
- **Type**: Dropdown menu (or individual buttons)
- **Location**: Right-aligned; context menu or dedicated action buttons
- **Swift ref**: `.contextMenu` on `NodeCard` button
- **Actions** (see §4 below):
  - Cordon (shown when schedulable)
  - Uncordon (shown when cordoned)
  - Drain (always shown, destructive)
  - View YAML (deferred — "soon")

---

## 3. Expanded Detail Block

When a node row is expanded, an inline detail section is shown below the table row (same row colspan).

### Detail Layout (Two-Column Grid)

#### Left Column: System Info
- **Label**: "OS"
  - **Data**: `status.nodeInfo.osImage` or "—"
- **Label**: "Kernel"
  - **Data**: `status.nodeInfo.kernelVersion` or "—"
- **Label**: "Runtime"
  - **Data**: `status.nodeInfo.containerRuntimeVersion` or "—"
- **Label**: "Kubelet"
  - **Data**: `status.nodeInfo.kubeletVersion` or "—"
- **Label**: "Arch"
  - **Data**: `status.nodeInfo.architecture` or "—"

#### Middle Column: Network & Storage
- **Label**: "Internal IP"
  - **Data**: `status.addresses[type=="InternalIP"].address` or "—"
- **Label**: "Pod CIDR"
  - **Data**: `spec.podCIDR` or "—"
- **Label**: "Free CPU"
  - **Data**: `status.capacity.cpu` (formatted as cores) minus usage (if metrics available), or "—"
  - **Note**: Capacity only; no usage sparklines (metrics deferred per spec)
- **Label**: "Free Mem"
  - **Data**: `status.capacity.memory` (formatted as bytes) minus usage (if metrics available), or "—"
- **Label**: "Free Disk"
  - **Data**: `status.capacity["ephemeral-storage"]` (formatted as bytes) or "—"
  - **Note**: Disk usage from kubelet Summary API if available; falls back to capacity only

#### Pressure Conditions Section
- **Visibility**: Shown only if `status.conditions` contains conditions with `type != "Ready"` AND `status == "True"`
- **Header**: "PRESSURE" (small caps, pending color)
- **Each Condition**:
  - Bullet (colored dot, pending)
  - **Type** (monospace, bold): `condition.type`
  - **Message** (secondary text): `condition.message` (if present) or omitted
- **Swift ref**: `NodeCard.detailsBlock` pressure block loop

---

## 4. User Actions & kubectl Commands

All mutations are guarded by the confirm sheet showing exact kubectl before execution.

### Action: Cordon

**When shown**: Row is schedulable (`spec.unschedulable != true`)  
**Label**: "Cordon node" (context menu) or button  
**Action block**:
```json
{"kind":"cordon","node":"<node-name>","label":"Cordon node <node-name>"}
```
**kubectl**: `cordon <node-name>`  
**Result**: Marks node unschedulable; prevents new pods from being scheduled (but does not evict running pods).

### Action: Uncordon

**When shown**: Row is cordoned (`spec.unschedulable == true`)  
**Label**: "Uncordon node" (context menu) or button  
**Action block**:
```json
{"kind":"uncordon","node":"<node-name>","label":"Uncordon node <node-name>"}
```
**kubectl**: `uncordon <node-name>`  
**Result**: Marks node schedulable again.

### Action: Drain

**When shown**: Always available; destructive (confirm sheet warns)  
**Label**: "Drain node…" (context menu) or button with warning color  
**Action block**:
```json
{"kind":"drain","node":"<node-name>","destructive":true,"label":"Drain node <node-name>"}
```
**kubectl**: `drain <node-name> --ignore-daemonsets --delete-emptydir-data`  
(Default options per `DrainOptions` in Swift source; `gracePeriodSeconds`, `timeout`, `force`, `disableEviction` defaults omitted.)

**Behavior**:
1. Opens confirm sheet (shows exact kubectl command above).
2. Cordon + graceful eviction of all pods.
3. Daemonsets and pods with `emptyDir` volumes are handled (not blocked).

---

## 5. Summary Row (Header)

Display above the table:
- **Text**: "Nodes" (label) + node count (badge) + loading spinner (if `isLoading`)
- **Count source**: Total node count in store (not filtered)
- **Swift ref**: `NodesPanel.header` (PanelTitle + count badge + ProgressView)

---

## 6. Loading, Error & Empty States

### Loading
- **Indicator**: Spinner in header (animating when `isLoading`)
- **State**: Initial subscribe to nodes watch; between request and first snapshot
- **Store**: `useCluster((s) => s.isLoading)`

### Error
- **Display**: Monospace error text in red banner below header
- **Source**: `cache.error` (watch connection or kubectl failure)
- **Store**: `useCluster((s) => s.error)`
- **Dismissable**: Error persists until connection recovers

### Empty
- **Text**: "No nodes found" (generic)
- **Shown when**: `allNodes.length === 0 && !isLoading`
- **Note**: Nodes are cluster-scoped; no namespace filter, so empty is rare (indicates cluster connectivity loss)

---

## 7. Search & Filtering

**Search field**: Text input, real-time filter against node names + labels.

**Match logic** (mirrors `pods` panel):
- Case-insensitive substring match against:
  - Node name (`metadata.name`)
  - Label keys + values (`metadata.labels`)
- Empty/blank query matches all nodes
- Search result count shown as badge: `<shown> / <total>` (or just `<total>` if no search)

---

## 8. Sorting

**Primary sort**: Control-plane nodes first (by `Node.role == "control-plane"`)  
**Secondary sort**: Node name (lexicographic, case-sensitive per `localizedStandardCompare` in Swift)

**Memoization**: Sort is recomputed only when data changes (not on metrics polling).  
**Swift ref**: `NodesViewModel.sortedNodes` (memoized on `cache.dataRevision`)

---

## 9. Resource Capacity Display (NO USAGE METRICS)

Per spec, the web port does NOT include live CPU/memory/disk USAGE sparklines.

**Show ONLY**:
- `status.capacity["cpu"]` (formatted as cores: "2", "500m", etc.)
- `status.capacity["memory"]` (formatted as bytes: "8Gi", "512Mi", etc.)
- `status.capacity["ephemeral-storage"]` (formatted as bytes, or "—")
- `status.capacity["pods"]` (integer count or "—")

**Deferred** (metrics-server dependent, requires separate aggregator):
- Live CPU/memory usage (requires metrics-server + separate aggregation)
- Disk usage from kubelet `/stats/summary` API
- Sparklines or % usage bars (Swift includes these; web omits for MVP)

**Message**: If metrics unavailable, no warning badge—just show capacity only.

---

## 10. Exact Resource Watch & Subscribe Path

```typescript
// In NodesPanel.tsx useEffect:
useEffect(() => {
  subscribe('nodes', '*'); // cluster-scoped, no namespace
  return () => unsubscribe('nodes', '*');
}, []);

// Read from store:
const allNodes = useMemo(
  () => Object.values((resources['nodes'] ?? {}) as Record<string, Node>),
  [resources],
);
```

**Store location**: `resources['nodes']` is a key → Node object map.  
**Update path**: Server WebSocket delivers `{kind:'nodes', operation:'add'|'update'|'delete', object: Node}` → store upserts/removes.

---

## 11. Implementation Contract (Web Builder)

1. **File structure**:
   - `apps/web/src/panels/nodes/NodesPanel.tsx` — main component (use Table + row actions)
   - `apps/web/src/panels/nodes/nodeDisplay.ts` — pure helper functions (Ready detection, role parse, cordoned state, capacity format)
   - `apps/web/src/panels/nodes/types.ts` — Node/NodeStatus interfaces (copy from packages/k8s or extend)

2. **No new npm dependencies** beyond existing shadcn components.

3. **Use existing infra**:
   - `useCluster` store for resources
   - `subscribe`/`unsubscribe` from `@/lib/ws`
   - `ConfirmSheet` for all action confirms
   - `Table` components from shadcn
   - `DropdownMenu` for context menu

4. **TDD**: Write vitest tests for `nodeDisplay` helpers (Ready detection, role parsing, cordoned state, capacity formatting).

5. **Register panel**:
   - Add import to `App.tsx`
   - Add `'/nodes'` route
   - Add `'nodes'` to `PANELS` array

6. **Verification**:
   - `pnpm --filter web typecheck` (no errors)
   - `pnpm --filter web build` (no errors)
   - `pnpm --filter web test` (pass vitest)
   - Manual: live table shows nodes, cordon/uncordon/drain open confirm sheet with exact kubectl

---

## 12. Acceptance Criteria

- [ ] Web panel displays live node list (sorted: control-plane first, then by name)
- [ ] Each row shows: name, status (Ready/NotReady), role (CONTROL-PLANE/WORKER), cordoned badge (if applicable)
- [ ] Click row to expand inline details: OS, Kernel, Runtime, Kubelet, Arch, Internal IP, Pod CIDR, pressure conditions
- [ ] Capacity values shown (CPU cores, memory bytes, ephemeral-storage, pod count)
- [ ] Search filter works against node names + labels (case-insensitive substring)
- [ ] Cordon action shown only when schedulable; opens confirm sheet with `kubectl cordon <node>`
- [ ] Uncordon action shown only when cordoned; opens confirm sheet with `kubectl uncordon <node>`
- [ ] Drain action always available; opens confirm sheet with `kubectl drain <node> --ignore-daemonsets --delete-emptydir-data`
- [ ] Error banner shown on watch failure; recovers on reconnect
- [ ] Loading spinner in header during initial subscribe
- [ ] Empty state shown when no nodes (edge case)
- [ ] TypeScript typecheck passes
- [ ] Unit tests pass for nodeDisplay helpers

