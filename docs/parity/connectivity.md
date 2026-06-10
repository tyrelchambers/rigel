# Connectivity Panel — Web port

## Overview

The **Connectivity** panel is a **read-only** operational map visualizing traffic paths from external ingresses through services to backing pods. It answers "what routes/connects to what?" by rendering:

- **External flows** — Ingress host + path → Ingress object → Service → backing Pods
- **Internal flows** — (ClusterIP services with no Ingress) Service → Pods (shown for reference)

The panel highlights **broken links** (ingress pointing to a missing service; service with no ready pods) in a warning color so operators can spot unreachable apps at a glance.

### Design Intent

NOT eye-candy. A strictly functional **diagnostic map** that traces reachability. Users should be able to:
1. See every service exposed via Ingress (external) and cluster-internal services
2. Spot which services have no pods or pods not ready
3. Understand the complete request path from external host to pod

---

## Data Model

### Flow Structure (derived, not stored)

The Connectivity module computes a flat list of **Flow** objects from three resource kinds:

```typescript
interface Flow {
  id: string;                    // "namespace/service-name" (unique key)
  hosts: string[];               // Ingress hosts routing to this service (sorted, empty = internal)
  ingressNames: string[];        // Ingress object names (sorted)
  serviceName: string;           // Service name
  namespace: string;             // Service namespace
  serviceType: string;           // e.g. "ClusterIP", "—" if service missing
  serviceExists: boolean;        // true iff service with this name/ns exists
  readyPods: int;                // Count of pods matching selector AND phase=Running AND all containers ready
  totalPods: int;                // Count of pods matching selector (running or not)
  podNames: string[];            // Matching pod names (sorted)
  isExternal: boolean;           // true iff any Ingress routes to it
  issues: string[];              // Health warnings: ["Selector matches no pods"], ["3 pods, 0 ready"], ["Ingress points to missing service"]
  
  // Derived: health flag
  health: "ok" | "warn" | "broken"  // External + issues → "broken"; internal + issues → "warn"; else "ok"
}
```

### Algorithm (Connectivity.flows)

1. **Front-map** — For each Ingress rule (spec.rules[].http.paths[].backend.service.name):
   - Extract host (or mark as `*` if absent)
   - Collect all hosts and ingress names for "namespace/service-name" → **Front** (hosts set, ingresses set)

2. **Service loop** — For each Service:
   - Look up Front entry: if exists, flow is external; else internal
   - Match pods by selector (spec.selector): pods in same namespace where all selector labels match
   - Count ready pods: phase=Running AND all status.containerStatuses[].ready=true
   - Append Flow with health derived from:
     - No selector → no issue (ExternalName, headless) 
     - Selector, 0 pods matched → issue: "Selector matches no pods"
     - Selector, pods matched, 0 ready → issue: "{N} pod(s), 0 ready"
   - External + any issue → health=broken; internal + any issue → health=warn; else health=ok

3. **Dangling ingress routes** — For each Front entry with no matching Service:
   - Emit Flow with serviceExists=false, readyPods=0, totalPods=0, issues=["Ingress points to a service that doesn't exist"]

4. **Sort** — health ranking (broken < warn < ok), then namespace, then serviceName

---

## Kubernetes Subscriptions

The panel subscribes to **three resource kinds**, all live-watched via the store:

- `"ingresses"` — namespace scope (or `*` for all)
- `"services"` — namespace scope (or `*` for all)
- `"pods"` — namespace scope (or `*` for all)

Each subscription is placed via `subscribe(kind, namespace)` on mount and cleaned up on unmount.

### Kubectl Commands (server-side, read-only)

The web app does NOT run kubectl directly. The store queries the server's WebSocket endpoint with:

```json
{ "type": "subscribe", "kind": "ingresses", "namespace": "default" }
{ "type": "subscribe", "kind": "services", "namespace": "default" }
{ "type": "subscribe", "kind": "pods", "namespace": "default" }
```

Server translates to:

```bash
kubectl get ingresses --namespace default --watch -o json
kubectl get services --namespace default --watch -o json
kubectl get pods --namespace default --watch -o json
```

(Or `--all-namespaces` if namespace is `*`.)

---

## UI Layout & Rendering

### Structure (columnar/flow-based, not graph)

```
┌────────────────────────────────────────────────────────┐
│ Header: "Connectivity" title + Legend                  │
├────────────────────────────────────────────────────────┤
│ "External" section (N flows)                           │
│  ┌──────────────────────────────────────────────────┐  │
│  │ ▓ [globe] example.com, foo.io  →  [signpost]    │  │
│  │           ingress-1                              │  │
│  │           →  [network] svc/api  →  [pods] N/M   │  │
│  │ namespace: default                               │  │
│  │ ⚠️ exclamationmark.triangle: "0 pods ready"      │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│ "Internal" section (M flows)                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │ ▓ [lock] cluster  →  [network] svc/db  → [pods] │  │
│  │ namespace: default                               │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

### Header

- **Title** — "Connectivity" (styled as PanelTitle, matching other panels)
- **Legend** — Three swatches with health labels:
  - Green dot + "Reachable" (health=ok)
  - Yellow/orange dot + "Degraded" (health=warn)
  - Red dot + "Broken" (health=broken)

**Styling**: elevated background, subtle bottom border.

### Flow Row

Each Flow is rendered as a **card** with:

1. **Color bar** — Left 3px bar, color = health tint (green/yellow/red)

2. **Main chain** (flex row, gap=6):
   - If external:
     - **Host chip** — `[globe] example.com, foo.io` or `(no host)` if hosts empty
     - **Arrow** — `→` (tertiary foreground)
     - **Ingress chip** — `[signpost.right.fill] ingress-1, ingress-2`
     - **Arrow** — `→`
   - If internal:
     - **Cluster chip** — `[lock.fill] cluster` (tertiary)
     - **Arrow** — `→`
   - **Service chip** — `[network] svc/api` (clickable button)
     - Text color: primary if serviceExists, failed (red) if not
     - Button action: onSelectService(serviceName, namespace)
   - **Arrow** — `→`
   - **Pods chip** — `[shippingbox.fill] N/M pods` or `no service` if !serviceExists
     - Text color: health tint
     - Button action: onSelectPods(flow) (disabled if totalPods == 0)
     - Disabled if totalPods == 0
   - **Spacer**
   - **Namespace label** — right-aligned, mono font, tertiary foreground, e.g. `default`

3. **Issues line** (below main chain, if !issues.isEmpty):
   - Icon: `[exclamationmark.triangle.fill]` (health tint)
   - Text: joined issues (` · ` separator), mono, health tint
   - Indentation: left-padded to align under the flow

**Styling**:
- Card: elevated background, subtle border, rounded corners (sm radius)
- Hover: (optional enhancement, not required for parity)

### Empty State

When `flows.isEmpty` (no services in cluster):

```
         ↖ [arrow.triangle.branch icon]
         No services to map yet.
  Connectivity traces ingress → service → pods
  so you can spot unreachable apps.
```

Centered, large icon, secondary/tertiary text colors.

---

## User Actions & Interactions

### Service Card Click

- **Trigger**: Click on a service chip (button)
- **Handler**: `onSelectService(serviceName, namespace)`
- **Expected behavior** (not implemented in web yet, per deferred actions):
  - Jump to Services panel, filter to that service, or highlight it
  - (Or open a service detail view — TBD by integration point)

### Pod Chip Click

- **Trigger**: Click on pods chip (button), if totalPods > 0
- **Handler**: `onSelectPods(flow)`
- **Expected behavior** (not implemented in web yet, per deferred actions):
  - Jump to Pods panel, filter to matching pods

### READ-ONLY — No mutations

- No edit, delete, create actions
- No confirm sheets
- No kubectl writes

---

## Loading & Error States

### Initial load

On mount, before first snapshot arrives from store:
- Show spinner or "Loading connectivity…" placeholder
- `isLoading` from store reflects subscription status

### Store error

If the store reports `error` (watch dropped, connection lost):
- Display error banner (yellow/red) at top, e.g. "Connection lost: [details]"
- Keep last known Flows visible (stale but useful)

### Empty list

If `flows.isEmpty` (no services matched):
- Show empty state (as above)

### Namespace filter

- Panel respects `useCluster(s => s.namespaceFilter)` from store
- Update subscriptions when filter changes: unsubscribe old, subscribe new

---

## Display Helpers (Pure Functions)

All logic for deriving Flows must be unit-tested with `vitest`. Place in `connectivityDisplay.ts`:

### `computeFlows(ingresses: Ingress[], services: Service[], pods: Pod[]): Flow[]`

Implements the algorithm above:
1. Build fronts map from ingresses
2. Emit flows for each service
3. Emit flows for dangling ingress routes
4. Sort and return

### `isPodReady(pod: Pod): boolean`

```typescript
return pod.status?.phase === "Running" &&
  (pod.status?.containerStatuses ?? []).length > 0 &&
  (pod.status?.containerStatuses ?? []).every(cs => cs.ready);
```

### `getFlowHealth(flow: Flow): "ok" | "warn" | "broken"`

```typescript
if (!flow.issues.length) return "ok";
return flow.isExternal ? "broken" : "warn";
```

### `extractServiceNameFromIngressRoute(ingressRule: IngressRule): string`

Extract service name from a rule's backend.service.name (handle missing/empty).

### Other helpers as needed:
- Sort comparators
- Formatting (host display, pod count string)

---

## File Structure

```
apps/web/src/panels/connectivity/
├── ConnectivityPanel.tsx          # Main component + callbacks
├── connectivityDisplay.ts         # Pure functions (Flows, display helpers)
├── connectivityDisplay.test.ts    # vitest: edge cases, empty states, broken links
└── types.ts                       # Flow, HealthStatus (may reuse Ingress/Service/Pod from existing types)
```

### Integration Points

1. **App.tsx** — Add "connectivity" to PANELS array and route:
   ```tsx
   import ConnectivityPanel from "./panels/connectivity/ConnectivityPanel";
   // ...
   const PANELS = [..., "connectivity", ...];
   // ...
   <Route path="/connectivity" element={<div className="h-full overflow-auto p-4"><ConnectivityPanel /></div>} />
   ```

2. **Store** — `useCluster()` provides:
   - `resources["ingresses"]` — key by namespace/name or flattened
   - `resources["services"]` — key by namespace/name or flattened
   - `resources["pods"]` — key by namespace/name or flattened
   - `namespaceFilter` — current scope
   - `isLoading`, `error` — status

3. **WebSocket** — No new server routes; reuse existing watch subscription.

---

## Edge Cases & Validation

### Service with no selector

- `spec.selector` is null or `{}`
- No pods matched; no issue emitted (valid: ExternalName, headless)
- Flows still emitted (for reference, if exposed via Ingress)

### Pod not ready

- Running but containers not ready → not counted in readyPods
- Issue: "{total} pod(s), 0 ready"

### Duplicate service names across namespaces

- Keys are "namespace/service-name" in Flows (id field)
- Display always includes namespace label → no confusion

### Ingress with no rules or empty rules

- No flows emitted for that Ingress (fronts map remains empty)

### Ingress routing to a service in a different namespace

- Kubernetes allows it: rules[].backend.service.name refers to a service in the SAME namespace as the Ingress (Kubernetes restriction)
- Algorithm assumes same-ns matching (aligned with kubectl behavior)

### No hosts in Ingress rule

- host="" or null in spec.rules[]
- Displayed as "(no host)" in host chip
- Still tracked as external if Ingress exists

### LoadBalancer with no external address

- service.status.loadBalancer.ingress is empty/absent
- Still display as external (flow is external = fronts.contains(this service))
- NO external address shown in the flow (service detail not in Connectivity scope)

---

## Testing Strategy (vitest)

File: `connectivityDisplay.test.ts`

### Test Cases

1. **Compute flows — basic case**
   - One external Ingress → Service → Pod (ready)
   - Expect: one Flow with health=ok, readyPods=1, totalPods=1

2. **Broken link — Ingress → missing service**
   - Ingress rule points to "nonexistent-svc"
   - No Service with that name
   - Expect: one Flow with serviceExists=false, issues=["Ingress points to a service that doesn't exist"]

3. **Degraded — service with no ready pods**
   - Service has selector, pods matched but all NotReady
   - Expect: Flow with totalPods > 0, readyPods=0, issue="{N} pod(s), 0 ready"

4. **Internal only — service not exposed via Ingress**
   - Service exists, pods match
   - No Ingress routes to it
   - Expect: Flow with isExternal=false, health=ok (no issues)

5. **Multiple Ingresses → same service**
   - Two Ingress objects route to one service
   - Expect: one Flow with ingressNames=[...], hosts=[...]

6. **Pod ready detection**
   - Pod phase=Running, all containers ready → isPodReady=true
   - Pod phase=Pending → isPodReady=false
   - Pod phase=Running, one container not ready → isPodReady=false
   - Empty containerStatuses → isPodReady=false

7. **Namespace isolation**
   - Service "default/api" and "prod/api"
   - Expect: two separate Flows, each with correct namespace

8. **No selector services**
   - Service has no selector (headless, ExternalName)
   - Expect: no pods matched, no issues (valid case)

---

## Performance Considerations

- **Computation**: Flows computed fresh on every render (pod/service/ingress changes)
  - O(ingresses * rules + services * pods) — acceptable for typical cluster
  - No caching needed (store updates trigger re-render anyway)
  - If cluster has 1000+ services/pods, consider memoizing with `useMemo` keyed on `[ingresses, services, pods]`

- **Subscriptions**: Three watches (ingress, service, pod) shared across all panels
  - Panel just subscribes/unsubscribes, doesn't manage the watch lifecycle

---

## Deferred Actions (not in parity scope)

- **Port-forward UI** — needs server subprocess manager
- **Service detail view** — jump to service panel; exact navigation TBD
- **Pod list detail** — jump to pods panel, filtered; exact navigation TBD
- **Ask Claude handoff** — needs diagnostics context builder
- **View YAML** — needs server endpoint + viewer UI
- **Forwarding badge** — needs server state polling

---

## Acceptance Criteria

1. **Panel exists** — `apps/web/src/panels/connectivity/ConnectivityPanel.tsx` renders
2. **Subscriptions** — Panel subscribes to `ingresses`, `services`, `pods` on mount; unsubscribes on unmount
3. **Flows computed** — `computeFlows()` matches Swift Connectivity.flows algorithm exactly
4. **UI rendered** — External/internal sections, flow rows with health colors, legend
5. **Broken links highlighted** — service not found, service with 0 ready pods → warning color + issue message
6. **No new npm deps** — layout hand-rolled with flex/SVG (no graph library)
7. **Read-only** — no mutations, no ConfirmSheet, no new server routes
8. **Tests pass** — `pnpm --filter web test` includes `connectivityDisplay.test.ts`
9. **Type-safe** — `pnpm --filter web typecheck` succeeds
10. **Server unchanged** — `pnpm --filter @helmsman/server test` passes; no changes to server logic

---

## References

- **Swift Source** — `Sources/Helmsman/Cluster/Connectivity.swift`, `Panels/Connectivity/ConnectivityPanel.swift`
- **Contracts** — `docs/parity/contracts.md`
- **CLAUDE.md** — `apps/CLAUDE.md`, `Sources/Helmsman/CLAUDE.md`
- **Related panels** — `docs/parity/services.md`, `docs/parity/ingresses.md`, `docs/parity/pods.md`
