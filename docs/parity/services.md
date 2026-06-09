# Services Panel — Normative Behavior Spec

This spec defines the behavior and implementation contract for porting the Swift Services panel to web. It is derived from reading `Sources/Helmsman/Panels/Services/ServicesPanel.swift`, `ServicesViewModel.swift`, and `Services.swift`.

## Scope: LIST view only (read-only, expandable detail; port-forward deferred)

This spec covers ONLY the live services table + expandable detail rows with no mutations. The following features are DEFERRED (out-of-scope-for-now) and must NOT be attempted without new infra:

- **Port-forward UI + control** — requires a long-running server-side forwarding process that does not yet exist in the web app. The Swift app manages port forwards in-process via `PortForwardManager`; the web server would need bidirectional WebSocket upgrade, session tracking, and a subprocess manager. DO NOT build a button that 422s. Document the action and skip the UI.
- **Edit/Create/Delete service mutations** — requires `ConfirmSheet` wiring and server action routes (already done for pods/nodes; can be added later).
- **Ask Claude handoff** — requires context-building for service diagnostics (will be added in a separate handoff spec).

The builder MUST use the EXISTING Phase A infra (services watch + search) and NOT modify the server beyond what is already supported (services watch is pre-built).

## Live Data Source

All service data comes from the Zustand store, fed by the WebSocket-based live watch:

- **Subscribe on mount**: Call `subscribe('services', namespace)` where `namespace` is the current namespace filter (default: `'*'` for all namespaces, or a specific namespace name).
- **Read from store**: `useCluster().resources['services']` returns a map of `{ name: Service }`. Service type matches the Kubernetes Service JSON schema (see `Sources/Helmsman/Cluster/KubeTypes.swift`).
- **Auto-update**: Store patches come from the server's `WatchManager` via WebSocket (`/ws`). The server already watches services via `kubectl get services --watch -o json`.

## Table Columns

Each column is derived directly from the Service JSON; columns render in this order:

| Column      | Source JSON Path                 | Format / Display Logic                                                                                              |
|-------------|----------------------------------|---------------------------------------------------------------------------------------------------------------------|
| **Namespace** | `metadata.namespace`            | Monospace, secondary text color. Show "—" if nil (though services should always have a namespace).                      |
| **Name**      | `metadata.name`                 | Monospace, primary text color. Service name (unique within namespace).                                                  |
| **Type**    | `spec.type`                     | Colored badge. "ClusterIP" (primary), "NodePort" (primary), "LoadBalancer" (primary), "ExternalName" (secondary). Defaults to "ClusterIP" if spec is missing. |
| **Cluster IP** | `spec.clusterIP` | Monospace, tertiary text. Show value if non-empty and not "None"; otherwise show "—". Only for ClusterIP/NodePort/LoadBalancer types (not ExternalName). |
| **Ports**   | `spec.ports[]` | Comma-separated list of port summaries. Each summary: `<port>:<nodePort>→<targetPort>/<protocol>` (or simplified based on fields present). Examples: "80/TCP", "8080:30080→9090/TCP". Show "no ports" if `spec.ports` is empty/nil. |
| **Endpoints** | Pod count matching `spec.selector` | Monospace. Show count of ready pods with labels matching `spec.selector` in the same namespace. Color: red if 0, secondary otherwise. Show "—" if no selector (headless/ExternalName). Computed via `cache.pods(matchingLabels:in:)`. |
| **External Address** | `status.loadBalancer.ingress[]`, `spec.externalIPs[]`, `spec.externalName` | Monospace, secondary text. Priority: (1) LoadBalancer ingress IPs/hostnames (comma-separated), (2) static externalIPs, (3) externalName. Show "—" if none. Line limit and truncate with ellipsis. |
| **Age**     | `metadata.creationTimestamp`    | Relative age: "5s", "3m", "2h", "1d", etc. Same logic as `K8sEvent.relativeAge()` in Swift.                       |

### Port Summary Formatting

Port summaries are computed from `spec.ports[].{ port, targetPort, nodePort, protocol }` using the same logic as Swift `Service.portSummaries`:

```
portSummaries = ports.map(p => {
  const head = (p.nodePort !== nil) ? `${p.port}:${p.nodePort}` : `${p.port}`;
  const arrow = (p.targetPort !== nil && p.targetPort !== String(p.port)) ? `→${p.targetPort}` : "";
  return `${head}${arrow}/${p.protocol ?? "TCP"}`;
})
```

Example:
- Port 80 → targetPort 8080 → `80→8080/TCP`
- Port 8080 (NodePort 30080) → targetPort 9090 → `8080:30080→9090/TCP`
- Port 443 (no target) → `443/TCP`

## Expanded Detail Block (Inline Row)

When a service row is expanded (via chevron toggle), an inline detail section is shown below the table row.

### Detail Layout

#### Ports Section
- **Header**: "PORTS"
- **List**: Each port as a full row with name (if present), port, targetPort, protocol, nodePort (if present), all in monospace.
- **Example**:
  ```
  http (80 → 8080 / TCP)
  https (443 → 8443 / TCP, NodePort: 30443)
  ```

#### Selector Section
- **Header**: "SELECTOR" (only shown if `spec.selector` is non-empty)
- **Content**: Key-value pairs from `spec.selector`, one per line, monospace. Format: `key=value`.
- **Example**:
  ```
  app=web
  tier=frontend
  ```

#### External Address Section
- **Header**: "EXTERNAL" (only shown if external address exists)
- **Content**: Full external address(es) from LoadBalancer ingress, externalIPs, or externalName.
- **Example**:
  ```
  LoadBalancer IP: 203.0.113.45
  ```
  or
  ```
  ExternalName: example.com
  ```

**Swift ref**: `ServiceRow` inline detail (not fully rendered in the current Swift panel, but structure inferred from the manager sheet).

## Filtering & Search

### Namespace Scoping
- The panel reads the namespace filter from the ClusterCache (set by a namespace selector elsewhere in the app).
- If `cache.namespaceFilter == nil`, show services from ALL namespaces (subscribe with `'*'`).
- If `cache.namespaceFilter == "default"` (or any namespace), show only services in that namespace.
- The store already receives only the services in the subscribed namespace (the server filters server-side in `WatchManager.subscribe()`).

### Search
- Client-side substring search (case-insensitive) across:
  - Service name (`metadata.name`)
  - Namespace (`metadata.namespace`)
  - Type label (`spec.type`)
  - Cluster IP (`spec.clusterIP`)
  - Port summaries (`spec.ports[].port`, `.targetPort`, `.nodePort` formatted as strings)
  - Selector keys and values (`spec.selector` as `key=value`)
- Return true if ANY field contains the search query.
- Update filtered list in real time as the user types.
- Swift ref: `ServicesViewModel.filteredServices` filtering logic with `cache.filtered(…, extras:)`.

### Count Chip
- Show total service count. If a search is active and results differ, show `<filtered> / <total>`.
- Example: "5" if all shown; "2 / 5" if search narrows the list.

## Empty / Loading / Error States

### Loading
- Show a small progress spinner in the header (next to the service count) while `cache.isLoading === true`.
- The store's `isLoading` flag is set by the server on first snapshot (before any services arrive).

### Error
- If `cache.error` is non-null, render a red error banner above the table.
- Text: the error message from the server (e.g., "kubectl failed: connection refused").
- Font: monospace, small, red background.

### Empty
- If no services exist (after filtering/search), the table body is empty but the header and search still render.
- Display: "No services found" in the table area.

## Row Actions: NONE (Read-Only)

The Swift panel has the following actions in the context menu, which are DEFERRED for web:

- **Forward port** — DO NOT IMPLEMENT. Requires long-running server-side port-forwarding infrastructure that does not yet exist. Document in DEFERRED section.
- **Edit service** — DEFERRED (ConfirmSheet + server mutation routes).
- **Ask Claude** — DEFERRED (separate handoff spec).
- **View YAML** — DEFERRED (separate YAML viewer spec).
- **Delete service** — DEFERRED (ConfirmSheet + server mutation route).

## Row State Indicators

### Forwarding Badge
- **Visibility**: Shown in the title row if any active port forward exists for this service.
- **Condition**: `viewModel.portForwards.forwards.contains { $0.targetKind == "svc" && $0.targetName == service.metadata.name && $0.namespace == ns }`
- **UI**: Monospace badge with arrow icon and text "forwarding" (status-running color).
- **Note**: On web, port-forward state would live on the server. This badge is DEFERRED along with the port-forward feature.

## Data Derivation & Computed Properties

### Endpoint Count
Swift method: `ServicesViewModel.endpointCount(for:) -> Int?`

```swift
func endpointCount(for service: Service) -> Int? {
    guard let selector = service.spec?.selector, !selector.isEmpty else { return nil }
    return cache.pods(matchingLabels: selector, in: service.metadata.namespace).count
}
```

Returns the count of ready pods with labels matching the service selector, or `nil` if the service has no selector (headless, ExternalName). The web implementation must call the equivalent store method.

### Forwardable Ports
Swift property: `Service.forwardablePorts`

```swift
var forwardablePorts: [Port] {
    isExternalName ? [] : (spec?.ports ?? [])
}
```

Returns empty array for ExternalName services; all ports for other types. (Deferred on web; document only.)

### External Address Derivation
Swift property: `Service.externalAddress`

```swift
var externalAddress: String? {
    let lb = (status?.loadBalancer?.ingress ?? []).compactMap { $0.ip ?? $0.hostname }
    if !lb.isEmpty { return lb.joined(separator: ", ") }
    if let ips = spec?.externalIPs, !ips.isEmpty { return ips.joined(separator: ", ") }
    if let ext = spec?.externalName, !ext.isEmpty { return ext }
    return nil
}
```

Priority: LoadBalancer ingress (IPs/hostnames) → static externalIPs → externalName. Returns nil if none exist. Used for the "External Address" column and expanded detail block.

## Deferred Features (Out-of-Scope)

Do NOT implement these without explicit changes to the spec:

1. **Port-forward UI + management** — Requires:
   - Server-side port-forward subprocess manager (PortForwardSession equivalent).
   - WebSocket upgrade to bidirectional streaming (or polling-based status).
   - Session tracking (local port assignment, lifecycle).
   - Client UI for starting/stopping forwards.
   - Status badge for active forwards (requires server state polling).

2. **Service mutations (Edit/Create/Delete)** — Requires:
   - ConfirmSheet wiring (exists for pods; can be reused).
   - Server action routes: `buildCommand({ kind: "deleteResource", resourceKind: "service", ... })`.
   - Form UI for editing service YAML.

3. **Ask Claude handoff** — Requires:
   - Context builder for service diagnostics (selector match, endpoint health, etc.).
   - Button row below the table header (next to Search).
   - Handoff protocol to chat.

4. **View YAML** — Requires:
   - Server endpoint: fetch `kubectl get service <name> -n <namespace> -o yaml`.
   - Client YAML viewer/editor (syntax highlighting, copy-to-clipboard).

## kubectl Watch & Resource Type

**Kind**: `services`  
**Namespace-scoped**: Yes (subscription includes namespace).  
**kubectl command (internal server logic)**:
```
kubectl get services --watch -o json [-n <namespace>]
```

When the namespace filter changes, the client unsubscribes from the old namespace and re-subscribes to the new one.

## Implementation Notes (for the builder)

### Store Integration
```typescript
// In your component:
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";

const { resources, namespaceFilter, isLoading, error } = useCluster();
const services = resources['services'] ?? {}; // returns { name: Service, ... }

useEffect(() => {
  const ns = namespaceFilter ?? '*';
  subscribe('services', ns);
  return () => unsubscribe('services', ns);
}, [namespaceFilter]);
```

### Service Type
The Service interface must match:
```typescript
interface Service {
  metadata: {
    name: string;
    namespace?: string;
    uid: string;
    creationTimestamp?: string; // ISO 8601 date
    labels?: Record<string, string>;
  };
  spec?: {
    type?: string; // "ClusterIP" | "NodePort" | "LoadBalancer" | "ExternalName"
    clusterIP?: string;
    selector?: Record<string, string>;
    ports?: Array<{
      name?: string;
      port: number;
      targetPort?: { stringValue: string }; // Can be numeric or named ("8080" or "http")
      protocol?: string; // "TCP" | "UDP" | "SCTP"
      nodePort?: number;
    }>;
    externalName?: string;
    externalIPs?: string[];
  };
  status?: {
    loadBalancer?: {
      ingress?: Array<{
        ip?: string;
        hostname?: string;
      }>;
    };
  };
}
```

### Display Helper Functions
Create `apps/web/src/panels/services/servicesDisplay.ts` with:
- `relativeAge(iso: string | undefined): string` — (reuse from pods)
- `portSummary(port: Port): string` — Format single port as `port:nodePort→targetPort/protocol`
- `portSummaries(ports: Port[]): string[]` — Array of formatted port strings
- `externalAddress(service: Service): string | null` — Derive LoadBalancer/externalIPs/externalName
- `typeLabel(service: Service): string` — Service type or "ClusterIP" (default)
- `matchesSearch(service: Service, query: string): boolean` — Case-insensitive substring match across name, namespace, type, clusterIP, ports, selector
- `sortServices(services: Service[]): Service[]` — Stable sort: namespace, then name

Write unit tests in `apps/web/src/panels/services/servicesDisplay.test.ts` using vitest (ports formatting, external address derivation, search matching).

### Component Structure
Place the panel at: `apps/web/src/panels/services/ServicesPanel.tsx`
- Export default: a React component.
- Import and register in `apps/web/src/App.tsx` in the Routes and PANELS array.
- Use shadcn `Button`, `Table`, `Accordion` or custom chevron toggle for expandable rows, and `DropdownMenu` if adding deferred actions later.
- Style with Tailwind v4 (no additional CSS).
- State: `search` (string), `expanded` (Set<string> keyed by service uid).

### Expandable Row Implementation
Mirror the Nodes panel pattern:
```typescript
// Track expanded services by uid
const [expanded, setExpanded] = useState<Set<string>>(new Set());

function toggleExpand(service: Service) {
  const uid = service.metadata.uid;
  setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(uid)) next.delete(uid);
    else next.add(uid);
    return next;
  });
}

// In table body:
{filtered.map((service) => (
  <Fragment key={service.metadata.uid}>
    <TableRow>
      {/* Chevron + columns */}
    </TableRow>
    {expanded.has(service.metadata.uid) && (
      <TableRow>
        <TableCell colSpan={8}>
          <ServiceDetail service={service} />
        </TableCell>
      </TableRow>
    )}
  </Fragment>
))}
```

### No Server Changes Required
- The server already has:
  - `kubectl get services --watch` (WatchManager).
- Do NOT add new watch kinds.
- Do NOT modify packages/k8s unless types are missing (services type should already be in the shared schema if pods are implemented).

## Acceptance Criteria

1. ✓ Table renders all 8 columns (Namespace, Name, Type, Cluster IP, Ports, Endpoints, External Address, Age).
2. ✓ Live data flows from Zustand store, updates in real-time via WebSocket.
3. ✓ Namespace filtering works (respects `cache.namespaceFilter`, subscribes with `'*'` for all-namespaces).
4. ✓ Search filters across name, namespace, type, clusterIP, ports, and selector labels.
5. ✓ Expandable detail rows show ports, selector, and external address; chevron toggles open/close.
6. ✓ Endpoint count computed correctly from pod label matching.
7. ✓ Port summaries formatted correctly (e.g., `80→8080/TCP`, `8080:30080→9090/TCP`).
8. ✓ External address derivation respects LoadBalancer → externalIPs → externalName priority.
9. ✓ Loading, error, and empty states render correctly.
10. ✓ `pnpm --filter web typecheck && pnpm --filter web build && pnpm --filter web test` passes.
11. ✓ `pnpm --filter @helmsman/server test` passes (no server changes).
12. ✓ No port-forward UI, edit/delete mutations, Ask Claude, or YAML viewer are built.
13. ✓ Port-forward, mutations, and other deferred features are documented in the code as TODO/DEFERRED comments.

