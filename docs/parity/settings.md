# Settings Panel Parity Spec

## Overview
The Settings panel manages two major features:
1. **Signal notifications bridge** — deploy self-hosted signal-cli-rest-api, link a phone, configure recipients.
2. **App-level settings** — self-hosted deployment defaults (ingress domain, image pull secret, etc.) + notification config (model selection, webhook URL).

This spec documents the exact kubectl operations, status derivations, cluster watches, and UI flows.

---

## 1. Signal Notifications Bridge

### 1.1 Manifest Structure & Deployment

The Signal bridge is a multi-doc YAML template applied via `POST /api/apply`:

```
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: signal-cli-data
  namespace: <NAMESPACE>
  labels:
    app.kubernetes.io/managed-by: helmsman-assistant
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: signal-cli-rest
  namespace: <NAMESPACE>
  labels:
    app.kubernetes.io/name: signal-cli-rest
    app.kubernetes.io/managed-by: helmsman-assistant
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app.kubernetes.io/name: signal-cli-rest
  template:
    metadata:
      labels:
        app.kubernetes.io/name: signal-cli-rest
    spec:
      containers:
        - name: signal-cli-rest-api
          image: bbernhard/signal-cli-rest-api:latest
          imagePullPolicy: IfNotPresent
          env:
            - name: MODE
              value: native
          ports:
            - containerPort: 8080
          volumeMounts:
            - name: data
              mountPath: /home/.local/share/signal-cli
          resources:
            requests:
              cpu: 25m
              memory: 128Mi
            limits:
              memory: 512Mi
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: signal-cli-data
---
apiVersion: v1
kind: Service
metadata:
  name: signal-cli-rest
  namespace: <NAMESPACE>
  labels:
    app.kubernetes.io/managed-by: helmsman-assistant
spec:
  selector:
    app.kubernetes.io/name: signal-cli-rest
  ports:
    - port: 8080
      targetPort: 8080
```

**Template substitution:** `<NAMESPACE>` is replaced with the assistant's installed namespace, or "default" if not yet installed.

**kubectl operation:** `POST /api/apply` with body `{"yaml": "<multi-doc-yaml>"}` runs:
```
kubectl apply -f - (< manifest stdin, no shell)
```

### 1.2 Bridge Status Derivation

Status is derived from cluster state and fed to the UI as a live state machine:

```typescript
enum SignalBridgeStatus {
  notDeployed   // No signal-cli-rest Deployment in target namespace
  deploying     // kubectl apply in flight (tracked by a local `statusApplying` flag)
  starting      // Deployment exists but no ready replica (readyReplicas < 1)
  ready         // Pod running, no sender number saved yet
  linked        // Pod running & sender number in assistant-config ConfigMap
}

derive(deployments: Deployment[], namespace: string, hasSavedNumber: bool, applying: bool) -> Status {
  if (applying) return deploying
  let dep = deployments.find(d => d.metadata.name == "signal-cli-rest" && d.metadata.namespace == namespace)
  if (!dep) return notDeployed
  if ((dep.status?.readyReplicas ?? 0) < 1) return starting
  return hasSavedNumber ? linked : ready
}
```

**Cluster watches required:** `deployments` (cluster-wide, filtered by namespace in derive).

**Persisted state:** `hasSavedNumber` comes from `assistant-config` ConfigMap's `signalNumber` key (non-empty string = linked).

### 1.3 Phone-Link Flow (Port-Forward + QR)

**User action:** Click "Link phone" button.

**Server flow:**
1. Client calls `/api/signal` with action `"link"` (new route defined below).
2. Server establishes a port-forward tunnel to the signal-cli-rest Service in the target namespace.
3. Server calls `GET http://127.0.0.1:<localPort>/v1/qrcodelink?device_name=helmsman` on the bridge.
4. Returns PNG bytes as the response body.

**UI flow:**
1. Display "Opening link channel…" loading state.
2. Fetch QR PNG from `/api/signal` (on success, display the image).
3. Prompt: "Scan in Signal → Settings → Linked devices → Link new device".
4. Poll `GET /api/signal?action=status` every 2 seconds to check if a phone has linked.
5. When accounts() returns a non-empty number, save it to the assistant-config ConfigMap (via the server) and stop polling.

**Error states:**
- Port-forward fails → show error, hide QR, allow Cancel.
- QR fetch fails → show error, allow Retry/Cancel.
- Linking timeout → can be cancelled anytime.

**Cancel button:** Terminates the port-forward session and clears the linking state.

### 1.4 Bridge Health & Restart Signals

The bridge Deployment is watched continuously (via the deployments resource kind in the cluster store). The panel derives status and renders:
- **Status dot** (color coded):
  - Tertiary gray = "not deployed"
  - Pending amber = "deploying" or "starting"
  - Accent blue = "ready" (linked device capable)
  - Running green = "linked"
- **Status label** (mono font): e.g., "Bridge ready — link a phone" or "Linked".
- **Namespace indicator**: e.g., "ns: default".

---

## 2. Signal Configuration (Per-Recipient & Two-Way)

Once the bridge is linked, the panel shows:
- **Recipients field** (comma-separated phone numbers, e.g., "+15551234567, +15559876543").
- **Save button** — writes the recipients list to the `assistant-config` ConfigMap.
- **Send test notification button** — brief port-forward, POST test message, verify chain works.
- **Two-way toggle** — enable/disable the agent polling the bridge for inbound commands from recipients.

### 2.1 Recipient Configuration

**kubectl operation (via POST /api/action):**
```
kubectl patch cm assistant-config -n <NS> --type=merge -p '{"data":{"signalRecipients":"<comma-sep-list>"}}'
```

Actually, the server implements this via the assistant ConfigMap handler. The web app calls:
```
POST /api/assistant
{
  "action": "setSignal",
  "apiUrl": "http://signal-cli-rest.<ns>.svc.cluster.local:8080",
  "number": "<linked-number>",
  "recipients": "<comma-sep>"
}
```

This is a read-modify-write on `assistant-config`:
```
kubectl get cm assistant-config -n <NS> -o json
# Merge updates
kubectl apply -f - < updated-cm.json
```

### 2.2 Send Test Notification

**User action:** Click "Send test notification" button.

**Preconditions:**
- Bridge is linked (sender number is saved).
- At least one recipient is configured and saved.

**kubectl operations:**
1. Port-forward to signal-cli-rest Service:
   ```
   kubectl port-forward svc/signal-cli-rest <local-port>:8080 -n <NS>
   ```
2. POST to the bridge's `/v2/send` endpoint:
   ```
   POST http://127.0.0.1:<local-port>/v2/send
   Content-Type: application/json
   
   {
     "message": "✅ Helmsman test notification — Signal is wired up.",
     "number": "<sender-number>",
     "recipients": ["<recipient1>", "<recipient2>", ...]
   }
   ```
3. Tear down the port-forward.

**Error messages:**
- "No linked sender number — link your phone first." (if signalNumber is empty)
- "Add at least one recipient (then Save) before sending a test." (if recipients is empty)
- "Port-forward failed: <stderr>" (if port-forward fails)
- "Test send failed: <error>" (if the bridge rejects the POST)

### 2.3 Two-Way Signal Configuration

**kubectl operation (via server POST /api/assistant):**
```
kubectl patch cm assistant-config -n <NS> --type=merge -p '{"data":{"signalInbound":"true"|"false"}}'
```

**Data flow:**
1. User toggles the "Let me text the assistant back (two-way)" switch.
2. Client sends `POST /api/assistant` with `action: "setSignal"` and the new inbound flag.
3. Server reads assistant-config, merges the update, and applies it.
4. ConfigMap is watched and reflected in the UI in real-time.

---

## 3. Self-Hosted Install Defaults

These are per-kubectl-context settings stored in `SessionStore` (Swift) / localStorage (web).

### 3.1 Persisted Fields (in localStorage)

```typescript
interface SelfHostDefaults {
  clusterIssuer: string;        // TLS ClusterIssuer name (e.g., "letsencrypt-prod")
  ingressDomain: string;        // Base domain for app ingresses (e.g., "apps.example.com")
  imagePullSecret: string;      // Kubernetes pull-secret name
  redirectMiddleware: string;   // Traefik HTTPS-redirect middleware ref
  edgeIP: string;               // Public edge IP (informational)
}
```

**Storage key:** `helmsman_selfhost_defaults_<kubectl-context>` (in localStorage, JSON-encoded).

### 3.2 UI Fields & Save Flow

Six text input fields in a card labeled "Self-hosted app defaults":
- **Ingress domain** — placeholder "apps.example.com"
- **Image pull secret** — placeholder "(none)"
- **Redirect middleware** — placeholder "(none)"
- **Edge IP** — placeholder "(optional)"

**Save button behavior:**
1. Trim whitespace from all fields.
2. Serialize to JSON and store in localStorage under the context key.
3. Set `selfHostSaved = true` (UI shows a checkmark briefly).
4. Reset `selfHostSaved = false` if any field changes (edit detected).

**No kubectl operations** — these are client-side defaults fed into the catalog install wizard's prompt to Claude.

---

## 4. App-Level Notification Settings

These persist in the `assistant-config` ConfigMap (shared with the signal config above).

### 4.1 Persisted Fields (in assistant-config)

```
assistant-config ConfigMap data:
  signalApiUrl:     "http://signal-cli-rest.<ns>.svc.cluster.local:8080"
  signalNumber:     "+15551234567"  (the linked sender)
  signalRecipients: "+15559876543"  (comma-sep list)
  signalInbound:    "true" | "false"
```

No additional fields in Settings panel beyond these (the assistant mode, quiet window, webhook URL, etc., are in the Assistant panel, not Settings).

### 4.2 Panel-to-Server Communication

All ConfigMap writes go through:
```
POST /api/assistant
{
  "action": "setSignal",
  "apiUrl": "...",
  "number": "...",
  "recipients": "...",
  "inbound": true|false
}
```

Server implementation (pseudocode):
```
action = "setSignal":
  read assistant-config ConfigMap
  merge { signalApiUrl, signalNumber, signalRecipients, signalInbound }
  apply merged ConfigMap
```

---

## 5. Cluster Watches & Real-Time Updates

The Settings panel subscribes to:
- **`deployments` (cluster-wide)** — watch for signal-cli-rest Deployment status changes.
- **`configmaps` (cluster-wide)** — watch for assistant-config changes (and assistant-state for linked number).

**Refresh cadence:** WebSocket-driven live updates from the cluster (subscribe/unsubscribe via `/ws`).

---

## 6. Error States & Edge Cases

### 6.1 Bridge Not Deployed Yet
- **Status:** "Bridge not deployed"
- **UI:** Show "Deploy Signal bridge" button.
- **Manifest disclosure:** "Show manifest" collapsible to preview the YAML before applying.

### 6.2 Bridge Deploying
- **Status:** "Deploying bridge…"
- **UI:** Progress indicator, disable Deploy button.
- **Duration:** Watch readyReplicas; transitions to "starting" or "ready" when pod comes up.

### 6.3 Bridge Starting (Pod Pending)
- **Status:** "Bridge starting…"
- **UI:** Progress indicator, disable all controls.
- **Resolution:** When readyReplicas >= 1, auto-advance to "ready" or "linked" (if number is saved).

### 6.4 Bridge Ready (No Phone Linked Yet)
- **Status:** "Bridge ready — link a phone"
- **UI:** Show "Link phone" button.
- **Manifest visibility:** Manifest disclosure is hidden (already deployed).

### 6.5 Linking in Progress
- **UI:** Show QR code (or loading spinner if fetching).
- **Polling:** Every 2 seconds, call accounts() to detect a linked number.
- **Timeout:** Linking can be cancelled at any point via Cancel button (tears down port-forward).

### 6.6 Bridge Linked (Sender Configured)
- **Status:** "Linked"
- **UI:** 
  - Display linked number (e.g., "Linked as +15551234567").
  - Show Re-link button (restarts the link flow).
  - Show Recipients field (empty defaults to send-to-self, the sender number).
  - Show Save button for recipients.
  - Show Send test button.
  - Show Two-way toggle.

### 6.7 Port-Forward Failures
- **Deploy:** If `kubectl apply` fails, show error: "Deploy failed: <stderr>".
- **Linking:** If port-forward fails, show: "Port-forward failed: <stderr>", hide QR, allow Cancel.
- **Test send:** If port-forward fails, show: "Port-forward failed: <stderr>".
- **QR fetch:** If `GET /v1/qrcodelink` fails (bridge not responding), show: "Could not load QR code: <error>".

### 6.8 Missing Dependencies
- **No recipients configured:** "Add at least one recipient (then Save) before sending a test."
- **No sender number:** "No linked sender number — link your phone first."
- **Finish linking first:** If user clicks "Send test" while linking, show: "Finish linking before sending a test."

---

## 7. Server Routes (New/Modified)

### 7.1 POST /api/signal (NEW)
Bridges the Signal phone-link flow. Port-forwards to the signal-cli-rest Service and proxies requests to its REST API.

**Request body:**
```typescript
{
  action: "link" | "status" | "accounts",
  namespace?: string,           // target namespace (defaults to assistant's ns)
  // localPort: implicit, server picks 18099 (avoiding 8080 collision)
}
```

**Response:**
- **action: "link"**: Returns PNG bytes (QR code image).
- **action: "status"**: Returns `{ ready: boolean }` (port-forward is open).
- **action: "accounts"**: Returns `{ accounts: string[] }` (registered numbers).

**Implementation:**
1. Establish port-forward to `svc/signal-cli-rest:<namespace>` → local 18099.
2. Make HTTP request to `http://127.0.0.1:18099/<path>`.
3. Return response body (PNG for QR, JSON for accounts).
4. Tear down port-forward on error or after success.

**Error responses:**
- `{ error: "Port-forward failed: <stderr>" }` (500)
- `{ error: "Could not reach bridge: <http-error>" }` (500)

### 7.2 POST /api/apply (EXISTING)
Already supports deploying the bridge manifest.

**Request body:**
```typescript
{ yaml: string }  // multi-doc YAML (the manifest from SignalBridgeManifests)
```

**kubectl operation:**
```
kubectl apply -f - < <yaml>
```

### 7.3 POST /api/assistant (EXISTING)
Extended to handle Signal configuration updates (if not already present).

**Request body:**
```typescript
{
  action: "setSignal",
  apiUrl: string,
  number: string,
  recipients: string,
  inbound?: boolean,
}
```

**Implementation:** Read-modify-write on `assistant-config` ConfigMap in the assistant's namespace.

---

## 8. Web Implementation Checklist

### 8.1 Module Structure
```
apps/web/src/
  ├── panels/settings/
  │   ├── SettingsPanel.tsx              # Main UI
  │   ├── useSettings.ts                 # Derived state (like useAssistant)
  │   ├── SignalBridgeManifests.ts       # Template & substitution
  │   ├── SignalBridgeStatus.ts          # Status derivation logic
  │   └── settings.test.ts               # Tests
  └── lib/
      └── signal.ts                      # Client helper (optional, if needed)

apps/server/src/
  ├── signal.ts                          # Port-forward + bridge API proxy (NEW)
  └── index.ts                           # Add POST /api/signal route
```

### 8.2 Component Tree
```
SettingsPanel
  ├── SignalSection
  │   ├── StatusRow
  │   ├── ErrorBox (if error)
  │   ├── DeployControls (if notDeployed)
  │   ├── BusyState (if deploying/starting)
  │   ├── LinkControls (if ready)
  │   │   ├── QRCodeDisplay (if linking && has PNG)
  │   │   └── CancelButton
  │   └── LinkedControls (if linked)
  │       ├── LinkStatus
  │       ├── ReLink button
  │       ├── RecipientField + Save
  │       ├── SendTestButton
  │       ├── TwoWayToggle
  │       └── InboundHelp text
  └── SelfHostSection
      ├── IngressDomainField
      ├── ImagePullSecretField
      ├── RedirectMiddlewareField
      ├── EdgeIPField
      └── SaveButton + SavedIndicator
```

### 8.3 Key Behaviors

**Deployed Manifest URL:**
```
POST /api/apply
{ yaml: "<bridge-manifest>" }
```

**Bridge Status:** Derived from `store.resources.deployments` (keyed by "signal-cli-rest" + namespace).

**Phone Linking:**
1. User clicks "Link phone".
2. Client calls `POST /api/signal { action: "link", namespace: <ns> }`.
3. Server returns PNG bytes.
4. Client polls `POST /api/signal { action: "accounts" }` every 2 seconds.
5. When accounts list contains a number, call `POST /api/assistant { action: "setSignal", … }` to save it.
6. Stop polling, update status to "Linked".

**Recipients Save:**
```
POST /api/assistant
{
  "action": "setSignal",
  "apiUrl": "...",
  "number": "...",
  "recipients": "<user-input>",
  "inbound": <current-toggle-state>
}
```

**Test Send:**
```
POST /api/signal
{
  "action": "sendTest",
  "number": "<sender-number>",
  "recipients": <parsed-list>,
  "namespace": <ns>
}
```

---

## 9. Test Coverage (TDD)

### 9.1 Unit Tests (`apps/web/src/panels/settings/settings.test.ts`)

- **Manifest substitution:** Verify `<NAMESPACE>` is replaced correctly.
- **Status derivation:** Test all 5 states given various deployment/configmap inputs.
- **Recipients parsing:** Comma-separated list → array (trim whitespace, empty filter).
- **SelfHostDefaults:** localStorage get/set round-trip, context isolation.

### 9.2 Integration Tests (`apps/server/src/signal.test.ts`)

- **Port-forward + QR fetch:** Mock the port-forward and verify the bridge API is called correctly.
- **Accounts polling:** Verify retry logic when accounts() returns empty, stop on first non-empty.
- **Test send:** Verify POST body is correctly formed and sent through the port-forward.

### 9.3 Server Tests (`apps/server/src/index.test.ts`)

- **POST /api/signal:** Verify requests are forwarded to the bridge and responses are returned correctly.
- **Error handling:** Verify port-forward failures are logged (without exposing internal details) and user-friendly errors returned.

---

## 10. Verifier Script

```bash
# Build + test checklist
pnpm --filter web typecheck
pnpm --filter web test        # Must include settings.test.ts
pnpm --filter web build

pnpm --filter @helmsman/server test  # Must include signal.test.ts
pnpm --filter @helmsman/server build

# Manual acceptance
# 1. Load /settings in the web app
# 2. Deploy Signal bridge (verify "Show manifest" collapsible)
# 3. Wait for bridge to start (verify status transitions)
# 4. Click "Link phone" (verify QR displays, polling starts)
# 5. Scan QR, verify number saves when phone links
# 6. Enter recipients, save, verify ConfigMap is updated
# 7. Click "Send test", verify message is sent
# 8. Toggle "Two-way", verify ConfigMap is updated
# 9. Edit self-host defaults, save, verify localStorage persists
# 10. Verify "Re-link" button restarts the link flow
```

---

## 11. Constraints & Notes

- **No new npm dependencies** beyond shadcn (no QR library; render link as text/clickable if needed).
- **All cluster writes via argv/no-shell routes** (POST /api/apply, POST /api/assistant, POST /api/signal).
- **Guarded uninstall:** Bridge deletion must go through a confirm sheet (use the shared purge or action-block flow).
- **Live updates:** All state changes (bridge status, config changes) are WebSocket-driven from the cluster store.
- **Signal bridge manifest:** Source of truth is in the code (SignalBridgeManifests module), not external YAML file.

