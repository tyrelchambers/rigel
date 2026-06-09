# Ingresses Panel — Normative Behavior Spec

This spec defines the behavior and implementation contract for porting the Swift Ingresses panel to web. It is derived from reading `Sources/Helmsman/Panels/Ingresses/IngressesPanel.swift`, `IngressesViewModel.swift`, `IngressEditorSheet.swift`, `IngressManageSheet.swift`, and the `Ingress` type in `Sources/Helmsman/Cluster/KubeTypes.swift`.

## Scope: LIST view only (read-only, expandable routing detail; mutations deferred)

This spec covers ONLY the live ingresses table + expandable detail rows with no mutations. The following features are DEFERRED (out-of-scope-for-now) and must NOT be attempted without new infra:

- **Create/Edit/Delete ingress mutations** — requires `ConfirmSheet` wiring, server action routes, and form UI for ingress YAML editing. The Swift editor supports ingress class, routing rules (host/path/service/port), TLS configuration, cert-manager integration, and annotations. Do NOT build buttons that 422s.
- **Ask Claude handoff** — requires context-building for ingress diagnostics (will be added in a separate handoff spec).
- **View YAML** — requires a server YAML endpoint and client viewer UI.
- **Cert-manager integration (automatic HTTPS)** — The Swift editor loads ClusterIssuers and auto-generates TLS entries. On web, defer this until mutations are implemented.

The builder MUST use the EXISTING Phase A infra (ingresses watch + search) and NOT modify the server beyond what is already supported (ingresses watch is pre-built).

## Live Data Source

All ingress data comes from the Zustand store, fed by the WebSocket-based live watch:

- **Subscribe on mount**: Call `subscribe('ingresses', namespace)` where `namespace` is the current namespace filter (default: `'*'` for all namespaces, or a specific namespace name).
- **Read from store**: `useCluster().resources['ingresses']` returns a map of `{ name: Ingress }`. Ingress type matches the Kubernetes Ingress JSON schema (see `Sources/Helmsman/Cluster/KubeTypes.swift`).
- **Auto-update**: Store patches come from the server's `WatchManager` via WebSocket (`/ws`). The server already watches ingresses via `kubectl get ingresses --watch -o json`.

## Table Columns

Each column is derived directly from the Ingress JSON; columns render in this order:

| Column      | Source JSON Path                 | Format / Display Logic                                                                                              |
|-------------|----------------------------------|---------------------------------------------------------------------------------------------------------------------|
| **Namespace** | `metadata.namespace`            | Monospace, secondary text color. Show "—" if nil (though ingresses should always have a namespace).                      |
| **Name**      | `metadata.name`                 | Monospace, primary text color. Ingress name (unique within namespace).                                                  |
| **Class**    | `spec.ingressClassName`         | Colored badge. Show the class name (e.g., "nginx", "istio", "traefik"). Default: show "—" if nil or empty.     |
| **Hosts**     | `spec.rules[].host`             | Comma-separated list of unique hosts from all routing rules. Show "—" if no rules. Example: "example.com, api.example.com". |
| **TLS**       | `spec.tls[]` length (yes/no)    | Badge or icon indicator. Show "TLS" with lock icon if `spec.tls` is non-empty and contains at least one entry with a `secretName`. Show "—" or blank if no TLS entries. |
| **TLS Secret** | `spec.tls[].secretName`        | If TLS present: show the first TLS secret name (or "mixed" if multiple secrets used). Monospace, secondary text. Only shown in expanded detail. |
| **External Address** | `status.loadBalancer.ingress[]` | Monospace, secondary text. Address assigned by the ingress controller. Priority: IP address first, then hostname. Show "—" if not yet assigned. Example: "203.0.113.45" or "lb.example.com". |
| **Age**     | `metadata.creationTimestamp`    | Relative age: "5s", "3m", "2h", "1d", etc. Same logic as `K8sEvent.relativeAge()` in Swift.                       |

## Expanded Detail Block (Inline Row)

When an ingress row is expanded (via chevron toggle), an inline detail section is shown below the table row.

### Detail Layout

#### Rules Table
- **Header**: "ROUTES (<count>)" where count is the number of routing rules.
- **Columns**: Host, Path, Service:Port (with arrow indicator).
- **Content**: Each row represents a single host/path → service:port routing rule, derived from flattening `spec.rules[].http.paths[]`.
- **Format**:
  - Host: `spec.rules[].host` (or "*" if nil)
  - Path: `spec.rules[].http.paths[].path` (or "/" if nil)
  - PathType: `spec.rules[].http.paths[].pathType` (shown in expanded detail only, if needed)
  - Service: `spec.rules[].http.paths[].backend.service.name` (or "—" if nil)
  - Port: `spec.rules[].http.paths[].backend.service.port.number` or `.port.name` (or "—" if nil, or show name if present)
  - Arrow icon between path and service:port for visual separation
- **Empty state**: "No routing rules" if `spec.rules` is empty/nil.
- **Default backend**: If `spec.defaultBackend.service` exists, show as a route with host="*", path="/", and backend service:port.
- **Example**:
  ```
  example.com    /api           → api-service:8080
  example.com    /static        → static-service:80
  api.example.com /              → backend-service:3000
  *              /              → fallback-service:80 (default backend, if present)
  ```

#### TLS Section
- **Header**: "TLS" (only shown if `spec.tls` is non-empty)
- **Content**: Each TLS entry: hosts + secret name.
  - Hosts: `spec.tls[].hosts[]` (comma-separated, or "*" if nil/empty)
  - Secret: `spec.tls[].secretName`
  - Format: `example.com, api.example.com → secret-name` (or hosts as "—" if empty)
- **Example**:
  ```
  example.com, api.example.com → tls-secret-prod
  wildcard.example.com → tls-wildcard
  ```

#### Class and Address Summary
- **Header**: "DETAILS"
- **Class**: `spec.ingressClassName` (or "—" if nil).
- **External Address**: `status.loadBalancer.ingress[].ip` or `.hostname` (or "—" if not assigned). Multiple addresses joined by ", ".
- **Format** (key-value):
  ```
  CLASS     nginx
  ADDRESS   203.0.113.45
  ```

**Swift ref**: `IngressManageSheet` layout (summary block + routes block).

## Filtering & Search

### Namespace Scoping
- The panel reads the namespace filter from the ClusterCache (set by a namespace selector elsewhere in the app).
- If `cache.namespaceFilter == nil`, show ingresses from ALL namespaces (subscribe with `'*'`).
- If `cache.namespaceFilter == "default"` (or any namespace), show only ingresses in that namespace.
- The store already receives only the ingresses in the subscribed namespace (the server filters server-side in `WatchManager.subscribe()`).

### Search
- Client-side substring search (case-insensitive) across:
  - Ingress name (`metadata.name`)
  - Namespace (`metadata.namespace`)
  - Ingress class (`spec.ingressClassName`)
  - All hosts (`spec.rules[].host`)
  - All backend service names (`spec.rules[].http.paths[].backend.service.name`)
- Return true if ANY field contains the search query.
- Update filtered list in real time as the user types.
- Swift ref: `IngressesViewModel.filteredIngresses` filtering logic using `cache.filtered(…, extras:)`.

### Count Chip
- Show total ingress count. If a search is active and results differ, show `<filtered> / <total>`.
- Example: "5" if all shown; "2 / 5" if search narrows the list.

## Empty / Loading / Error States

### Loading
- Show a small progress spinner in the header (next to the ingress count) while `cache.isLoading === true`.
- The store's `isLoading` flag is set by the server on first snapshot (before any ingresses arrive).

### Error
- If `cache.error` is non-null, render a red error banner above the table.
- Text: the error message from the server (e.g., "kubectl failed: connection refused").
- Font: monospace, small, red background.

### Empty
- If no ingresses exist (after filtering/search), the table body is empty but the header and search still render.
- Display: "No ingresses found" in the table area.

## Row Actions: NONE (Read-Only)

The Swift panel has the following actions in the context menu, which are DEFERRED for web:

- **Edit ingress** — DEFERRED (ConfirmSheet + server mutation routes + form UI).
- **Ask Claude** — DEFERRED (separate handoff spec).
- **View YAML** — DEFERRED (separate YAML viewer spec).
- **Delete ingress** — DEFERRED (ConfirmSheet + server mutation route).

## Data Derivation & Computed Properties

### Ingress Class
Swift property: `Ingress.className`

```swift
var className: String { spec?.ingressClassName ?? "—" }
```

Returns the class name or "—" if nil/empty.

### TLS Enabled
Swift property: `Ingress.isTLS`

```swift
var isTLS: Bool { !(spec?.tls?.isEmpty ?? true) }
```

Returns true if `spec.tls` is non-empty (at least one TLS entry exists).

### Hosts List
Swift property: `Ingress.hosts`

```swift
var hosts: [String] {
    Array(Set((spec?.rules ?? []).compactMap { $0.host })).sorted()
}
```

Unique, sorted list of hosts from all routing rules. Return empty array if no rules.

### Routes (Flattened)
Swift property: `Ingress.routes`

```swift
var routes: [IngressRoute] {
    var out: [IngressRoute] = []
    for rule in spec?.rules ?? [] {
        for p in rule.http?.paths ?? [] {
            out.append(IngressRoute(
                host: rule.host ?? "*",
                path: p.path ?? "/",
                service: p.backend.service?.name ?? "—",
                port: Self.portLabel(p.backend.service?.port)
            ))
        }
    }
    if let def = spec?.defaultBackend?.service {
        out.append(IngressRoute(host: "*", path: "/", service: def.name, port: Self.portLabel(def.port)))
    }
    return out
}

static func portLabel(_ port: ServicePort?) -> String {
    if let n = port?.number { return String(n) }
    return port?.name ?? ""
}
```

Flattens all routing rules into a list of `(host, path, service, port)` tuples for display. Includes default backend if present. Port is formatted as a number string or named port, or empty string if missing.

### External Address
Swift property: `Ingress.address`

```swift
var address: String? {
    let parts = (status?.loadBalancer?.ingress ?? []).compactMap { $0.ip ?? $0.hostname }
    return parts.isEmpty ? nil : parts.joined(separator: ", ")
}
```

External address(es) assigned by the ingress controller's load balancer. Priority: IP addresses first, then hostnames. Returns nil if `status.loadBalancer.ingress` is empty or no IP/hostname is present.

## kubectl Watch & Resource Type

**Kind**: `ingresses`  
**Namespace-scoped**: Yes (subscription includes namespace).  
**kubectl command (internal server logic)**:
```
kubectl get ingresses --watch -o json [-n <namespace>]
```

When the namespace filter changes, the client unsubscribes from the old namespace and re-subscribes to the new one.

## Kubernetes Ingress JSON Schema (Relevant Fields)

```json
{
  "metadata": {
    "name": "string",
    "namespace": "string",
    "uid": "string",
    "creationTimestamp": "ISO 8601 timestamp"
  },
  "spec": {
    "ingressClassName": "string",
    "rules": [
      {
        "host": "string (optional)",
        "http": {
          "paths": [
            {
              "path": "string",
              "pathType": "Prefix | Exact | ImplementationSpecific",
              "backend": {
                "service": {
                  "name": "string",
                  "port": {
                    "number": 0,
                    "name": "string"
                  }
                }
              }
            }
          ]
        }
      }
    ],
    "tls": [
      {
        "hosts": ["string"],
        "secretName": "string"
      }
    ],
    "defaultBackend": {
      "service": {
        "name": "string",
        "port": {
          "number": 0,
          "name": "string"
        }
      }
    }
  },
  "status": {
    "loadBalancer": {
      "ingress": [
        {
          "ip": "string",
          "hostname": "string"
        }
      ]
    }
  }
}
```

## Implementation Notes (for the builder)

### Store Integration
```typescript
// In your component:
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";

const { resources, namespaceFilter, isLoading, error } = useCluster();
const ingresses = resources['ingresses'] ?? {}; // returns { name: Ingress, ... }

useEffect(() => {
  const ns = namespaceFilter ?? '*';
  subscribe('ingresses', ns);
  return () => unsubscribe('ingresses', ns);
}, [namespaceFilter]);
```

### Ingress Type
The Ingress interface must match:
```typescript
interface ServiceBackend {
  service?: {
    name: string;
    port?: {
      number?: number;
      name?: string;
    };
  };
}

interface Backend {
  service?: {
    name: string;
    port?: {
      number?: number;
      name?: string;
    };
  };
}

interface Path {
  path?: string;
  pathType?: string; // "Prefix" | "Exact" | "ImplementationSpecific"
  backend: Backend;
}

interface HTTP {
  paths: Path[];
}

interface Rule {
  host?: string;
  http?: HTTP;
}

interface TLS {
  hosts?: string[];
  secretName?: string;
}

interface LoadBalancerIngress {
  ip?: string;
  hostname?: string;
}

interface IngressSpec {
  ingressClassName?: string;
  rules?: Rule[];
  tls?: TLS[];
  defaultBackend?: Backend;
}

interface IngressStatus {
  loadBalancer?: {
    ingress?: LoadBalancerIngress[];
  };
}

interface Ingress {
  metadata: {
    name: string;
    namespace?: string;
    uid: string;
    creationTimestamp?: string; // ISO 8601 date
  };
  spec?: IngressSpec;
  status?: IngressStatus;
}

// Helper type for flattened routing display
interface IngressRoute {
  host: string;
  path: string;
  service: string;
  port: string;
}
```

### Display Helper Functions
Create `apps/web/src/panels/ingresses/ingressesDisplay.ts` with:
- `relativeAge(iso: string | undefined): string` — (reuse from pods)
- `className(ingress: Ingress): string` — Return `spec.ingressClassName` or "—"
- `isTLS(ingress: Ingress): boolean` — Return true if `spec.tls` is non-empty
- `hosts(ingress: Ingress): string[]` — Return unique sorted hosts from `spec.rules[].host`
- `externalAddress(ingress: Ingress): string | null` — Derive LoadBalancer IP/hostname(s) or null
- `flattenRoutes(ingress: Ingress): IngressRoute[]` — Flatten rules into host/path/service/port tuples (include default backend)
- `portLabel(port: ServicePort | undefined): string` — Format port as number string, name, or empty
- `matchesSearch(ingress: Ingress, query: string): boolean` — Case-insensitive substring match across name, namespace, class, hosts, service names
- `sortIngresses(ingresses: Ingress[]): Ingress[]` — Stable sort: namespace, then name

Write unit tests in `apps/web/src/panels/ingresses/ingressesDisplay.test.ts` using vitest:
- Test route flattening (including default backend).
- Test TLS detection (empty/non-empty arrays).
- Test external address derivation (IP, hostname, none).
- Test search matching across all fields.
- Test host extraction and deduplication.

### Component Structure
Place the panel at: `apps/web/src/panels/ingresses/IngressesPanel.tsx`
- Export default: a React component.
- Import and register in `apps/web/src/App.tsx` in the Routes and PANELS array.
- Use shadcn `Button`, `Table`, and custom chevron toggle for expandable rows.
- Style with Tailwind v4 (no additional CSS).
- State: `search` (string), `expanded` (Set<string> keyed by ingress uid).

### Expandable Row Implementation
Mirror the Services and Nodes panel pattern:
```typescript
// Track expanded ingresses by uid
const [expanded, setExpanded] = useState<Set<string>>(new Set());

function toggleExpand(uid: string) {
  setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(uid)) next.delete(uid);
    else next.add(uid);
    return next;
  });
}

// In table body:
{filtered.map((ing) => {
  const uid = ing.metadata.uid;
  const isOpen = expanded.has(uid);
  return (
    <Fragment key={uid}>
      <TableRow>
        {/* Chevron + columns */}
      </TableRow>
      {isOpen && (
        <TableRow>
          <TableCell colSpan={8}>
            <IngressDetail ingress={ing} />
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
})}
```

### No Server Changes Required
- The server already has:
  - `kubectl get ingresses --watch` (WatchManager).
- Do NOT add new watch kinds.
- Do NOT modify packages/k8s unless types are missing (ingress type should already be in the shared schema or can be added alongside other Kubernetes types).

## Acceptance Criteria

1. ✓ Table renders all 8 columns (Namespace, Name, Class, Hosts, TLS, External Address, Age).
2. ✓ Live data flows from Zustand store, updates in real-time via WebSocket.
3. ✓ Namespace filtering works (respects `cache.namespaceFilter`, subscribes with `'*'` for all-namespaces).
4. ✓ Search filters across name, namespace, class, hosts, and service names.
5. ✓ Expandable detail rows show routes table (host/path → service:port), TLS entries, and class/address summary; chevron toggles open/close.
6. ✓ Routes flattened correctly from `spec.rules[].http.paths[]`, including default backend if present.
7. ✓ External address derived correctly (IP priority over hostname, multiple addresses comma-separated, or nil if not assigned).
8. ✓ TLS detection works (badge shown only if `spec.tls` non-empty).
9. ✓ Loading, error, and empty states render correctly.
10. ✓ `pnpm --filter web typecheck && pnpm --filter web build && pnpm --filter web test` passes.
11. ✓ `pnpm --filter @helmsman/server test` passes (no server changes).
12. ✓ `apps/web/src/panels/ingresses/IngressesPanel.tsx` exists and exports default component.
13. ✓ `apps/web/src/panels/ingresses/ingressesDisplay.ts` exists with all helper functions.
14. ✓ No create/edit/delete mutations, Ask Claude, or YAML viewer are built.
15. ✓ Deferred features are documented in the code as TODO/DEFERRED comments.
16. ✓ Ingresses panel registered in `App.tsx` Routes and PANELS array.
