# Port-Forward Feature — Normative Behavior Spec

This spec defines the complete behavior for implementing port-forward in the web app. It is derived from reading the Swift implementation (`Sources/Helmsman/PortForward/PortForwardManager.swift`, `PortForwardSession.swift`) and the UI integration in `Sources/Helmsman/Panels/Services/PortForwardStartSheet.swift` and `ServicesPanel.swift`.

## Overview

Port-forward is a **deferred action** integrated into the Services panel. It allows users to forward a local port on the server to a port on a running Service (or Pod), running `kubectl port-forward svc/<name> <localPort>:<remotePort> -n <namespace>` in the background. The forward persists for the lifetime of the application (Swift native app) or server process (web), and is terminated when explicitly stopped or when the app/server shuts down.

**CRITICAL CAVEAT (must be documented in UI and docs)**:
The port-forward runs **INSIDE the server container**, so `127.0.0.1:<localPort>` is the server's loopback, reachable from the **host only when running the server locally/non-containerized**, or when that port is explicitly published. This differs from the native macOS app where the forward was directly on your machine. In containerized deployments, users must publish the local port or port-forward to `0.0.0.0` (not recommended) and access the server's IP from the host.

## Architecture

### Server-Side: Forward Process Manager (`apps/server/src/portForward.ts`)

A pure module managing the lifecycle of `kubectl port-forward` subprocesses. It must:
1. **Track active forwards** in memory with a unique ID, namespace, service/pod name, local port, remote port, and status.
2. **Allocate free local ports** if the client does not specify one.
3. **Spawn `kubectl port-forward`** via `Bun.spawn()` with proper argv (no shell) and bind address handling.
4. **Monitor status**: Detect when `kubectl` reports "Forwarding from ..." (ready), capture errors, and track termination.
5. **Stop forwards** on explicit request and automatically on server shutdown (kill all child processes, no zombie kubectl).

#### Forward Lifecycle

```
[START REQUEST] 
  ↓ (allocate local port if needed)
  ↓ (validate not already in use)
  ↓ (spawn kubectl port-forward)
  ↓
[STARTING] — waiting for kubectl to report "Forwarding from ..."
  ↓
[RUNNING] — kubectl reports ready; local socket is listening
  ↓ (user clicks Stop OR server shutdowns)
  ↓ (terminate() kills the process)
  ↓
[STOPPED/FAILED]
```

#### Kubectl Command Structure

**Template:**
```
kubectl port-forward <targetKind>/<targetName> <localPort>:<remotePort> -n <namespace> [--context <context>]
```

**Example:**
```bash
kubectl port-forward svc/my-service 8080:3000 -n default --context minikube
```

**Constraints:**
- `targetKind` is either `"svc"` or `"pod"` (web starts with `"svc"` only; pods are deferred).
- `targetName` is the service or pod name.
- `localPort` is the port on `127.0.0.1` (server-side loopback, default bind address).
- `remotePort` is the target port in the container.
- `namespace` is the Kubernetes namespace.
- `--context` is prepended if specified by the client (for multi-context support).
- **No shell**: Use `Bun.spawn(argv)` array; do NOT invoke `sh -c`.

#### Argv Building (Pure Function, TDD)

```typescript
function buildPortForwardArgs(
  targetKind: string,      // "svc" | "pod"
  targetName: string,
  namespace: string,
  localPort: number,
  remotePort: number,
  context?: string
): string[] {
  const args: string[] = [];
  if (context) {
    args.push("--context", context);
  }
  args.push(
    "port-forward",
    `${targetKind}/${targetName}`,
    `${localPort}:${remotePort}`,
    "-n", namespace
  );
  return args;
}
```

### Data Model: Active Forward

```typescript
interface ActiveForward {
  id: string;                    // UUID, unique session identifier
  namespace: string;
  service?: string;              // service name (on web, always present for "svc")
  pod?: string;                  // pod name (deferred; for "pod" target kind)
  targetKind: "svc" | "pod";
  localPort: number;             // bind address: 127.0.0.1 (constant)
  remotePort: number;            // container/service port
  status: "starting" | "running" | "failed";
  failureMessage?: string;       // stderr from kubectl on failure
  createdAt: number;             // timestamp (ms)
}
```

### Port Allocation (Pure Function, TDD)

If the client does NOT specify a local port, allocate a free one:

```typescript
function findFreeLocalPort(
  activeForwards: ActiveForward[],
  startPort: number = 8000
): number {
  // Recommended start: 8000. Search upward until a port not in use.
  const usedPorts = new Set(
    activeForwards
      .filter(f => f.status !== "failed")
      .map(f => f.localPort)
  );
  let port = startPort;
  while (usedPorts.has(port) || port > 65535) {
    port++;
  }
  if (port > 65535) throw new Error("No free local ports available");
  return port;
}
```

### REST API Endpoints

**Endpoint**: `POST /api/portforward`

**Request body** (JSON):
```typescript
{
  action: "start" | "stop" | "list";
  
  // For "start":
  namespace?: string;                    // required
  service?: string;                      // required (on web, only service supported)
  remotePort?: number;                   // required
  localPort?: number;                    // optional (auto-allocated if omitted)
  context?: string;                      // optional (multi-context support)
  
  // For "stop":
  id?: string;                           // required
  
  // "list" has no additional fields
}
```

**Response** (JSON):

- **start**: `{ ok: true, forward: ActiveForward }` or `{ ok: false, error: "..." }`
- **stop**: `{ ok: true }` or `{ ok: false, error: "..." }`
- **list**: `{ forwards: ActiveForward[] }`

**Errors**:
- `409 Conflict` if local port already in use (non-failed forward).
- `422 Unprocessable Entity` if validation fails (missing required fields, port out of range).
- `500 Internal Server Error` if kubectl spawn fails or process crashes.

### Status Transitions and Events

The module listens to stdout/stderr and process termination:

1. **Ready Event**: When stdout contains `"Forwarding from 127.0.0.1:<port>"`, the status changes to `"running"`.
2. **Failure Event**: If stderr or process exit code is non-zero, status changes to `"failed"` with the error message.
3. **Cleanup**: On explicit stop or server shutdown, the process is terminated (SIGTERM), and the entry is removed from the active forwards list.

### Server Shutdown Hook

The server MUST register a shutdown hook (Bun's `.terminal()` or equivalent) that:
1. Iterates all active forwards.
2. Calls `terminate()` on each (kills the subprocess).
3. Waits briefly for cleanup, then exits.

**No zombie processes allowed.**

---

## Client-Side (Web UI): Services Panel Integration

### UI: Port-Forward Action in Row Context

In the Services panel, when a service row is displayed, add a **Port-forward** action:

#### Placement
- **Context Menu** (right-click on service row or ellipsis button) OR
- **Row-level Action Button** (in the expanded detail section).

#### When to Show
- Show **only for non-ExternalName services** (ExternalName cannot be port-forwarded).
- If the service has multiple ports, show a submenu with one option per port (pick the target port).
- If the service has one port, show `"Forward port <port>"` as a single action.
- If no ports, disable or hide the action.

#### Triggering the Action

Clicking "Forward port" opens a **port-forward dialog** with:
1. Service name and namespace (display-only).
2. Remote port (display-only, from the selected port).
3. Local port input (text field, default: `<remote port>` if available, or auto-allocated; user may override).
4. Start button and Cancel button.

#### Dialog Validation
- Local port must be numeric, 1–65535.
- Local port must not be in use by another active forward (check against `/api/portforward list`).
- Show validation error inline if invalid.

### UI: Active Forwards List

Add a **collapsible section** above the services table:

#### Header
```
ACTIVE FORWARDS (3)
```

#### List Items
One item per active forward, showing:

```
[Status Indicator] <targetKind>/<targetName>:<remotePort> <namespace> [Link/Copy] [Stop Button] [Error Message if failed]
```

**Fields**:
- **Status Indicator**: Colored dot (pending/amber = `"starting"`, green = `"running"`, red = `"failed"`).
- **Target**: `svc/my-service:3000` (kind, name, remote port).
- **Namespace**: Monospace, tertiary color.
- **Link/Copy** (when running): Clickable `127.0.0.1:<localPort>` (attempts to open in browser if port looks like HTTP; always allows copy-to-clipboard).
- **Stop Button**: Red button "Stop" that calls `POST /api/portforward { action: "stop", id: "..." }`.
- **Error Display** (when failed): Red text with the first line of the error message (truncated if long).

#### Polling / Real-Time Updates
- **Initial load**: Call `GET /api/portforward list` on mount.
- **Polling**: Every 2–5 seconds, re-fetch the list to catch remote stops or server-side state changes.
- **Optimistic updates**: When the user clicks "Start" or "Stop", optimistically update the UI before the API call completes, then sync on response.

### UI: Forwarding Badge on Service Row

Add a small badge to the service row if any active forward exists for that service:

```
[Arrow Icon] Forwarding
```

**Color**: Status green (running).  
**Visibility**: Only shown if at least one active forward's `service === svc.metadata.name && namespace === svc.metadata.namespace && status === "running"`.

### Components to Create

1. **`apps/web/src/panels/services/PortForwardDialog.tsx`**: Modal dialog for starting a forward.
   - Inputs: service name, namespace, remote port, local port (with validation).
   - Handles: validation, submission, error display.
   
2. **`apps/web/src/panels/services/ActiveForwardsList.tsx`**: Collapsible list of active forwards.
   - Displays: status, target, local port link/copy, stop button, error message.
   - Handles: polling, optimistic updates, stop action.
   
3. **`apps/web/src/panels/services/ForwardRow.tsx`** (helper): Single forward item component.
   - Reusable row for one active forward.
   
4. **`apps/web/src/panels/services/portForward.ts`** (logic helpers, TDD):
   - `formatForwardLabel(forward: ActiveForward): string` — Format "svc/name:port" label.
   - `getForwardingServices(forwards: ActiveForward[], services: Service[]): Set<string>` — Service UIDs with active forwards for badge rendering.
   - `buildLocalPortDefault(remotePort?: number): number` — Suggest a local port.
   - Tests in `portForward.test.ts`.

5. **Integration in `ServicesPanel.tsx`**:
   - Add context menu item "Forward port" to each service row.
   - Conditionally render "ACTIVE FORWARDS" section above the table.
   - Show "Forwarding" badge on service rows with active forwards.

### TanStack Query / API Hooks

Create a custom hook for forward management:

```typescript
// apps/web/src/hooks/usePortForwards.ts
export function usePortForwards() {
  const [forwards, setForwards] = useState<ActiveForward[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchForwards = async () => {
    const res = await fetch("/api/portforward", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list" }),
    });
    const data = await res.json();
    if (res.ok) setForwards(data.forwards ?? []);
  };

  const startForward = async (
    namespace: string,
    service: string,
    remotePort: number,
    localPort?: number
  ) => {
    const res = await fetch("/api/portforward", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "start",
        namespace,
        service,
        remotePort,
        localPort,
      }),
    });
    if (res.ok) {
      await fetchForwards();
      return res.json();
    } else {
      throw new Error((await res.json()).error);
    }
  };

  const stopForward = async (id: string) => {
    await fetch("/api/portforward", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop", id }),
    });
    await fetchForwards();
  };

  // Poll every 3 seconds
  useEffect(() => {
    fetchForwards();
    const interval = setInterval(fetchForwards, 3000);
    return () => clearInterval(interval);
  }, []);

  return { forwards, isLoading, startForward, stopForward, refetch: fetchForwards };
}
```

---

## Kubectl Command Execution Details

### Swift PortForwardSession Model (Reference)

The Swift implementation in `PortForwardSession.swift`:

```swift
// Build args:
var args: [String] = []
if let context { args.append(contentsOf: ["--context", context]) }
args.append(contentsOf: [
  "port-forward", "\(targetKind)/\(targetName)", 
  "\(localPort):\(remotePort)", "-n", namespace,
])

// Spawn:
let p = Process()
p.executableURL = URL(fileURLWithPath: kubectl)
p.arguments = args
// Capture stdout + stderr
// On stdout "Forwarding from", yield .ready
// On non-zero exit or stderr, yield .failed(message)
```

### Web Implementation Requirements

**Use Bun.spawn with argv array** (no shell):

```typescript
const child = Bun.spawn({
  cmd: ["kubectl", ...buildPortForwardArgs(...)],
  stdout: "pipe",
  stderr: "pipe",
});

// Monitor stdout for "Forwarding from"
const reader = child.stdout.getReader();
let buffer = "";
const readLoop = async () => {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += new TextDecoder().decode(value);
    if (buffer.includes("Forwarding from")) {
      // Status → "running"
      reader.releaseLock();
      break;
    }
  }
};

// Monitor stderr for errors
const errReader = child.stderr.getReader();
let errBuffer = "";
const readErr = async () => {
  while (true) {
    const { value, done } = await errReader.read();
    if (done) break;
    errBuffer += new TextDecoder().decode(value);
  }
};

// On child termination or user stop, kill the process
child.kill();
```

---

## Bind Address and Loopback Isolation

### Default Bind Address
**Constant: `127.0.0.1`** (loopback only, server-side).

In the code:
```typescript
const BIND_ADDRESS = "127.0.0.1";

// Kubectl is invoked with:
// kubectl port-forward ... <localPort>:<remotePort>
// kubectl defaults to 127.0.0.1, but if needed to bind to all interfaces:
// kubectl port-forward --address 0.0.0.0 ...
// DO NOT expose 0.0.0.0 by default; document it as a manual override.
```

### Caveat Documentation

In the UI (dialog and/or active forwards list header):

```
⚠ Port forwarding runs inside the server container. The port 127.0.0.1:<port> 
is reachable from your machine only when running the server locally or when 
the port is published. In containerized deployments, you may need to adjust 
the server's bind address or publish the port.
```

Also document in `docs/parity/portforward.md` (this file) and in code comments.

---

## Testing Strategy

### Server-Side (TDD: Pure Functions)

**File: `apps/server/src/portForward.test.ts`** (Bun test)

Test these in isolation:

1. **`buildPortForwardArgs()`**:
   - No context → args do not include `--context`.
   - With context → args include `--context <name>`.
   - Correct order: `["--context", ctx, "port-forward", ...]`.

2. **`findFreeLocalPort()`**:
   - Empty forwards list → returns start port (8000).
   - One forward using 8000 → returns 8001.
   - Multiple forwards scattered → finds next available.
   - No free ports → throws error.

3. **Active forward bookkeeping**:
   - `start()` → entry added with `status = "starting"`.
   - `ready()` → status → `"running"`.
   - `failed()` → status → `"failed"`, message stored.
   - `stop()` → entry removed from list.
   - `stopAll()` → all entries removed.

4. **Port-in-use check**:
   - `isLocalPortInUse(8000)` with an active forward on 8000 → true.
   - Failed forward on 8000 → false (not considered "in use").

### Client-Side (TDD: Components & Helpers)

**File: `apps/web/src/panels/services/portForward.test.ts`** (vitest)

1. **`formatForwardLabel()`**: Outputs `"svc/name:port"`.
2. **`getForwardingServices()`**: Returns set of service names with active running forwards.
3. **Dialog validation**:
   - Empty local port → error.
   - Out-of-range port → error.
   - Port in use → error.
   - Valid port → no error.

### Integration Tests

1. **Server starts a forward**:
   - `POST /api/portforward { action: "start", ... }` → returns `{ ok: true, forward: { id, status: "starting", ... } }`.
   
2. **Forward transitions to running**:
   - Poll `/api/portforward { action: "list" }` until status = `"running"` (or timeout).
   
3. **Forward stop**:
   - `POST /api/portforward { action: "stop", id: "..." }` → process is killed, list no longer includes it.
   
4. **Server shutdown** (manual integration test):
   - Start several forwards, kill the server → all child processes terminated.

### All Tests Must Pass

```bash
pnpm -r typecheck
pnpm --filter @helmsman/server test
pnpm --filter web test
pnpm --filter web build
```

---

## Resource Kinds Watched

- **services**: Already watched (existing Services panel).
- **ports** (runtime): No Kubernetes watch; tracked in-process on the server.

---

## Acceptance Criteria

1. ✓ Server module `apps/server/src/portForward.ts` exists with pure functions (`buildPortForwardArgs`, `findFreeLocalPort`, status tracking) and spawn logic.
2. ✓ REST API `POST /api/portforward` with `start`, `stop`, `list` actions implemented and working.
3. ✓ Argv building is shell-free (Bun.spawn with array, no `sh -c`).
4. ✓ Processes are killed on `stop()` and on server shutdown (no zombie kubectl).
5. ✓ TDD: `apps/server/src/portForward.test.ts` covers arg building, port allocation, and bookkeeping; all pass.
6. ✓ Web: Port-forward dialog in Services panel ("Forward port" action, local port input, validation).
7. ✓ Web: Active forwards list above services table, shows status, local→remote mapping, stop button, errors.
8. ✓ Web: Forwarding badge on service rows with active forwards.
9. ✓ Web: TDD `apps/web/src/panels/services/portForward.test.ts` for display helpers and validation.
10. ✓ Caveat documented in UI (dialog header or help text) and in code comments.
11. ✓ All existing routes preserved (chat, watch, logs, metrics, apply, signal, assistant, purge, updates).
12. ✓ `pnpm -r typecheck && pnpm --filter web build && pnpm --filter web test && pnpm --filter @helmsman/server test` all pass.
13. ✓ Manual test: Start a forward → indicator shows `127.0.0.1:<localPort> → <svc>:<remotePort>`, active list updates. Stop → process killed, list updates.

---

## Implementation Phases

### Phase 1: Server Infrastructure (backend-first)
1. Write pure functions: `buildPortForwardArgs`, `findFreeLocalPort` (TDD).
2. Write forward lifecycle manager: start, stop, stopAll, status tracking.
3. Write REST endpoint `POST /api/portforward` with `start`, `stop`, `list` actions.
4. Register server shutdown hook to kill all forwards.
5. Write integration tests (spawn real kubectl, verify "Forwarding from" detection).

### Phase 2: Web UI (frontend)
1. Create port-forward dialog component (nested in Services panel).
2. Create active forwards list component (polling `GET /api/portforward`).
3. Add context menu item "Forward port" to service rows.
4. Add forwarding badge to service rows.
5. Write TDD tests for display helpers.
6. Integration test: start/stop forward via UI.

### Phase 3: Verification & Docs
1. Run full test suite: `pnpm -r typecheck && pnpm --filter web build && pnpm --filter web test && pnpm --filter @helmsman/server test`.
2. Manual acceptance test (local server, real cluster).
3. Ensure no zombie processes on shutdown.
4. Document caveat in UI and code.

