# Pods Panel — Normative Behavior Spec

This spec defines the behavior and implementation contract for porting the Swift Pods panel to web. It is derived from reading `Sources/Helmsman/Panels/Pods/PodsPanel.swift`, `PodsViewModel.swift`, and `PodManageSheet.swift`.

## Scope: LIST view only (focused, scoped to existing Phase A infra)

This spec covers ONLY the live pods table + delete action. The following features are DEFERRED (out-of-scope-for-now) and must NOT be attempted without new infra:
- **CPU/memory sparklines** — requires metrics collection in `ClusterCache` (metrics-server API polling, ring-buffer sampling).
- **Pod exec (terminal)** — requires WebSocket upgrade for bidirectional streaming + terminal emulator.
- **Log streaming** — requires WebSocket upgrade for bidirectional streaming + log pagination.
- **Ask Claude handoff** — requires context-building for pod diagnostics (will be added in a separate handoff spec).

The builder MUST use the EXISTING Phase A infra and NOT modify the server beyond what is already supported (pods watch + deletePod action are pre-built).

## Live Data Source

All pod data comes from the Zustand store, fed by the WebSocket-based live watch:

- **Subscribe on mount**: Call `subscribe('pods', namespace)` where `namespace` is the current namespace filter (default: 'default' or support `*` for all-namespaces).
- **Read from store**: `useCluster().resources['pods']` returns a map of `{ name: Pod }`. Pod type matches the Kubernetes Pod JSON schema (see `Sources/Helmsman/Cluster/KubeTypes.swift`).
- **Auto-update**: Store patches come from the server's `WatchManager` via WebSocket (`/ws`). The server already watches pods via `kubectl get pods --watch -o json`.

## Table Columns

Each column is derived directly from the Pod JSON; columns render in this order:

| Column      | Source JSON Path                 | Format / Display Logic                                                                                              |
|-------------|----------------------------------|---------------------------------------------------------------------------------------------------------------------|
| **Namespace** | `metadata.namespace`            | Monospace, secondary text color. Show "—" if nil (though pods should always have a namespace).                      |
| **Name**      | `metadata.name`                 | Monospace, primary text color. Pod name (unique within namespace).                                                  |
| **Status**    | `status.phase`                  | Colored pill. "Running" → green, "Pending" → yellow, "Failed" → red, "Succeeded" → green, unknown → gray. Show "—" if nil. |
| **Ready**     | `status.containerStatuses[].ready` | Monospace, secondary. Show `<ready_count>/<total_containers>`. If no containerStatuses, show "—". Computed as: `sum(containerStatuses.filter(c => c.ready)) / containerStatuses.length`. |
| **Restarts**  | `status.containerStatuses[].restartCount` | Monospace. Show sum of all container restart counts. Color: amber/warning if > 0, else muted. Show "0" if no statuses. |
| **Node**      | `spec.nodeName`                 | Monospace, tertiary (muted) text. Show "—" if nil (pod not yet scheduled).                                        |
| **Age**       | `metadata.creationTimestamp`    | Relative age: "5s", "3m", "2h", "1d", etc. Same logic as `K8sEvent.relativeAge()` in Swift.                       |

## Filtering & Search

### Namespace Scoping
- The panel reads the namespace filter from the ClusterCache (set by a namespace selector elsewhere in the app).
- If `cache.namespaceFilter == nil`, show pods from ALL namespaces.
- If `cache.namespaceFilter == "default"` (or any namespace), show only pods in that namespace.
- The store already receives only the pods in the subscribed namespace (the server filters server-side in `WatchManager.subscribe()`).

### Search
- Client-side substring search (case-insensitive) across:
  - Pod name (`metadata.name`)
  - Namespace (`metadata.namespace`)
  - Label keys and values (all `metadata.labels`)
- Return true if ANY field contains the search query.
- Update filtered list in real time as the user types.

### Count Chip
- Show total pod count. If a search is active and results differ, show `<filtered> / <total>`.
- Example: "5" if all shown; "2 / 5" if search narrows the list.

## Empty / Loading / Error States

### Loading
- Show a small progress spinner in the header (next to the pod count) while `cache.isLoading === true`.
- The store's `isLoading` flag is set by the server on first snapshot (before any pods arrive).

### Error
- If `cache.error` is non-null, render a red error banner above the table.
- Text: the error message from the server (e.g., "kubectl failed: connection refused").
- Font: monospace, small, red background.

### Empty
- If no pods exist (after filtering/search), the table body is empty but the header and search still render.
- Optionally show inline text: "No pods found" in the table area (or leave it blank).

## Row Actions: Delete Pod

### UI
- Each row has a "Delete" button (or context menu entry for right-click).
- Button text: "Delete" (in destructive red tint).
- Action: When clicked, set the action block with `kind: "deletePod"` and open the ConfirmSheet.

### ConfirmSheet Behavior
The ConfirmSheet (existing component at `apps/web/src/components/ConfirmSheet.tsx`) will:

1. **Preview**: Fetch `/api/action?preview=1` (POST with the action block).
   - Server response: `{ command: ["kubectl", "--context", "<context>", "delete", "pod", "<name>", "-n", "<namespace>"] }`
   - Render the exact command string in monospace font.

2. **Confirm**: Show "Cancel" and a destructive "Delete" button.

3. **Execute**: On "Delete", POST to `/api/action` (without preview flag).
   - Server runs: `kubectl --context <context> delete pod <name> -n <namespace>` (built by `buildCommand({ kind: "deletePod", pod: name, namespace: ns })` in `apps/server/src/actions.ts`).
   - Return: `{ code: 0, stdout: "pod \"<name>\" deleted", stderr: "" }` on success, or `{ code: 137, ..., stderr: "error: pods \"<name>\" not found" }` on failure.

4. **Result**: Display success ("Command succeeded") or error (stderr output) briefly, then auto-close on success.

### Exact kubectl Command
For a pod named `web` in namespace `default`:
```
kubectl --context <current-context> delete pod web -n default
```

The `--context` flag is added by the server if a context is available. The action block carries:
```json
{
  "kind": "deletePod",
  "pod": "<pod-name>",
  "namespace": "<namespace>",
  "destructive": true
}
```

## Deferred Features (Out-of-Scope)

Do NOT implement these without explicit changes to the spec:

1. **Metrics (CPU/Memory sparklines)** — Requires:
   - Pod metrics subscription (metrics.k8s.io/v1beta1 → PodMetrics).
   - Ring-buffer history in ClusterCache.
   - Charts rendering (canvas or SVG).

2. **Pod exec** — Requires:
   - WebSocket upgrade to bidirectional streaming.
   - Terminal emulator widget (xterm.js or similar).
   - Session tracking.

3. **Log streaming** — Requires:
   - WebSocket upgrade to bidirectional streaming.
   - Log pagination + follow mode.
   - Container selection within a pod.

4. **Ask Claude handoff** — Requires:
   - Context builder for pod diagnostics (reason why not ready, recent events, etc.).
   - Button row below the table header (next to Search).
   - Handoff protocol to chat.

## Implementation Notes (for the builder)

### Store Integration
```typescript
// In your component:
import { useCluster } from "@/store/cluster";
import { subscribe, unsubscribe } from "@/lib/ws";

const { resources, namespaceFilter } = useCluster();
const pods = resources['pods'] ?? {}; // returns { name: Pod, ... }

useEffect(() => {
  const ns = namespaceFilter ?? 'default'; // adapt to your filter UI
  subscribe('pods', ns);
  return () => unsubscribe('pods', ns);
}, [namespaceFilter]);
```

### Pod Type
The Pod interface (from `packages/k8s` or server types) must match:
```typescript
interface Pod {
  metadata: {
    name: string;
    namespace?: string;
    uid: string;
    creationTimestamp?: string; // ISO 8601 date
    labels?: Record<string, string>;
  };
  spec: {
    nodeName?: string;
    containers: Array<{ name: string; image?: string; ports?: Array<{ containerPort: number; name?: string }> }>;
  };
  status?: {
    phase?: string; // "Running", "Pending", "Failed", "Succeeded", etc.
    podIP?: string;
    containerStatuses?: Array<{
      name: string;
      ready: boolean;
      restartCount: number;
      state?: {
        running?: { startedAt?: string };
        waiting?: { reason?: string; message?: string };
        terminated?: { reason?: string; exitCode?: number };
      };
    }>;
  };
}
```

### Action Block
Pass this to `useAction()` when Delete is clicked:
```typescript
const action: ActionBlock = {
  kind: "deletePod",
  pod: pod.metadata.name,
  namespace: pod.metadata.namespace ?? "default",
  destructive: true,
  label: `Delete pod ${pod.metadata.name}`,
};
```

### No Server Changes Required
- The server already has:
  - `kubectl get pods --watch` (WatchManager).
  - `buildCommand({ kind: "deletePod", ... })` in actions.ts.
- Do NOT add new watch kinds.
- Do NOT modify packages/k8s unless types are missing.

### Component Structure
Place the panel at: `apps/web/src/panels/pods/PodsPanel.tsx`
- Export default: a React component.
- Import and register in `apps/web/src/App.tsx` in the Routes.
- Use shadcn `Button`, `Table`, and `Sheet` components (already installed).
- Style with Tailwind v4 (no additional CSS).

## Acceptance Criteria

1. ✓ Table renders all 7 columns (Namespace, Name, Status, Ready, Restarts, Node, Age).
2. ✓ Live data flows from Zustand store, updates in real-time via WebSocket.
3. ✓ Namespace filtering works (respects `cache.namespaceFilter`).
4. ✓ Search filters across name, namespace, and labels.
5. ✓ Delete action opens ConfirmSheet and shows exact kubectl command.
6. ✓ Loading, error, and empty states render correctly.
7. ✓ `pnpm --filter web typecheck && pnpm --filter web build && pnpm --filter web test` passes.
8. ✓ `pnpm --filter @helmsman/server test` passes (no server changes).
9. ✓ ConfirmSheet correctly executes the delete and shows success/failure.
10. ✓ No metrics, exec, log streaming, or Ask Claude features are built.

