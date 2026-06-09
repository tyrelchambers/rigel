# Health Probe Parity Spec

## Overview

The Health Probe is a minimal indicator that shows whether the Kubernetes cluster is reachable and the API server is healthy. It is the ONLY element from the Overview panel being ported in this iteration—a deliberate dogfood of the orchestrator infrastructure, not a full panel.

## Data Source & Cluster Reachability

**kubectl Command (on demand):**
```bash
kubectl version --context=<context>
```

**How Swift determines reachability:**
- ClusterCache (`Sources/Helmsman/Cluster/ClusterCache.swift`) spawns parallel watch streams via `reconnectingWatch()` on resource types (pods, deployments, events, etc.).
- Each watch internally calls `kubectl get <resource> -o json` (via `getList()`). If the API server is unreachable, the list fails and `error` is set on the cache.
- StatusBar (`Sources/Helmsman/Shell/StatusBar.swift`, lines 57–72) reads `cache.error` and displays:
  - **Reachable:** green dot + "kubectl: ok" (line 67–71)
  - **Unreachable:** red dot + "kubectl: error" with tooltip showing the error message (line 58–64)

## Normative Web Behavior

### Endpoint
**Existing server endpoint (already implemented):**
```
GET /api/health
→ { "ok": true, "kubeconfig": "/path/to/kubeconfig" }
```

The endpoint returns static `ok: true` if the server process runs. **The web health probe must NOT use this directly.** Instead, it must poll for actual cluster connectivity by checking if any watch stream is alive or attempting a simple kubectl version call at the server level.

**For this iteration:** Use the existing `GET /api/health` endpoint with TanStack Query polling to determine server availability as a proxy for cluster health. A 200 response = reachable; timeout or non-200 = unreachable.

### Panel Layout

Single card with:
- **Indicator dot** (circle, 5px): green if reachable, red if unreachable.
- **Status label** (monospace, 10pt): "cluster: reachable" or "cluster: unreachable"
- **Tooltip:** On hover over the error state, show the error message (if available from the server's last watch error).

### User Actions

**None.** This is a read-only status indicator. No buttons, no confirm sheets, no mutations.

### Polling & Watch Behavior

- **Polling:** Every 5 seconds via TanStack Query with `staleTime: 0` and `gcTime: 0` to ensure continuous refetch.
- **Watch Kind(s):** No persistent watch. Each GET is a one-shot health check.
- **Backoff:** TanStack Query default retry (3 retries with exponential backoff) is acceptable.
- **Error Handling:**
  - Connection timeout: mark as unreachable.
  - HTTP 5xx: mark as unreachable.
  - Decode error: mark as unreachable.
  - HTTP 200: mark as reachable.

### Empty/Loading/Error States

| State | Display |
|-------|---------|
| **Loading (first fetch)** | Dot is gray, label: "cluster: checking…" |
| **Reachable (200 OK)** | Dot is green (#22c55e or equivalent), label: "cluster: reachable" |
| **Unreachable (error/timeout)** | Dot is red (#ef4444), label: "cluster: unreachable" |

## Columns/Fields

| Field | Source | Type | Notes |
|-------|--------|------|-------|
| `ok` | `GET /api/health` response | boolean | True = cluster reachable; false/absent = unreachable |
| `kubeconfig` | `GET /api/health` response | string | Path to the active kubeconfig (informational, not used for status) |

## kubectl Commands Issued

| Action | Command | Notes |
|--------|---------|-------|
| Implicit health poll | *None; handled server-side by watchdog or on-demand list* | The server's `/api/health` endpoint does not run kubectl itself; it's a static response. For future iterations, the server should run `kubectl version --context=<context>` on-demand or maintain a live watch. |

## Resource Kinds Watched

**None.** The health probe does not maintain a persistent watch. It polls the server's `/api/health` endpoint only.

## Navigation & Route

- **Route:** `/health`
- **Nav menu:** Add `"health"` to the `PANELS` array in `apps/web/src/App.tsx`.
- **Component:** `HealthPanel` at `apps/web/src/panels/health/HealthPanel.tsx`.

## Implementation Constraints

1. **No new npm dependencies.** Use existing React, TanStack Query, Tailwind, and shadcn/ui only.
2. **Single component file:** `apps/web/src/panels/health/HealthPanel.tsx` — no sub-components or additional files.
3. **No watch manager, WebSocket, kubectl wrappers, or confirm sheets.**
4. **Do NOT modify** `packages/k8s` or `apps/server`.
5. **Diff limit:** Under ~60 lines across all changes (including App.tsx route registration).

## Parity Notes

- Swift's StatusBar reads `cache.error` once per render to show reachability.
- Web's HealthPanel polls `GET /api/health` and renders the same visual indicator.
- Both show a dot + label + optional error tooltip.
- The server-side health endpoint is currently a no-op; a future implementation could run `kubectl version` or maintain a heartbeat watch.
