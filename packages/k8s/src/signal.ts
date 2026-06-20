// Signal notifications bridge — shared logic (docs/parity/settings.md §1-2).
//
// This module is the byte-identical source of truth for:
//   - the signal-cli-rest multi-doc manifest (PVC + Deployment + Service),
//   - the bridge status state machine derived from the live cluster,
//   - recipient-list parsing,
//   - the assistant-config ConfigMap read-modify-write for Signal config.
//
// No kubectl is run here — these are pure functions the web panel and the Bun
// server both call.

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/** Service/Deployment/PVC name for the bridge. */
export const SIGNAL_BRIDGE_NAME = "signal-cli-rest";

/** Port the signal-cli-rest container/service listens on. */
export const SIGNAL_BRIDGE_PORT = 8080;

/** Device name used when requesting a link QR from the bridge. */
export const SIGNAL_DEVICE_NAME = "rigel";

/**
 * Multi-doc YAML for the Signal bridge with `<NAMESPACE>` substituted. Applied
 * via `POST /api/apply` (kubectl apply -f - over stdin, no shell). The PVC keeps
 * the linked-device keys across restarts; the Deployment uses the Recreate
 * strategy so the RWO volume is never double-mounted.
 */
export function signalBridgeManifest(namespace: string): string {
  const ns = namespace.trim() || "default";
  return `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: signal-cli-data
  namespace: ${ns}
  labels:
    app.kubernetes.io/managed-by: rigel-assistant
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
  namespace: ${ns}
  labels:
    app.kubernetes.io/name: signal-cli-rest
    app.kubernetes.io/managed-by: rigel-assistant
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
  namespace: ${ns}
  labels:
    app.kubernetes.io/managed-by: rigel-assistant
spec:
  selector:
    app.kubernetes.io/name: signal-cli-rest
  ports:
    - port: 8080
      targetPort: 8080
`;
}

// ---------------------------------------------------------------------------
// Status state machine
// ---------------------------------------------------------------------------

export type SignalBridgeStatus =
  | "notDeployed" // No signal-cli-rest Deployment in the target namespace.
  | "deploying" // kubectl apply in flight (local `applying` flag).
  | "starting" // Deployment exists but readyReplicas < 1.
  | "ready" // Pod running, no sender number saved yet.
  | "linked"; // Pod running & a sender number is saved in assistant-config.

interface BridgeDeploymentLike {
  metadata: { name: string; namespace?: string };
  status?: { readyReplicas?: number };
}

/**
 * Derive the bridge status from the live deployments watch plus two flags.
 * Mirrors the spec's `derive(deployments, namespace, hasSavedNumber, applying)`.
 *   applying           → deploying
 *   no deployment      → notDeployed
 *   readyReplicas < 1  → starting
 *   sender saved       → linked, else ready
 */
export function deriveSignalBridgeStatus(
  deployments: BridgeDeploymentLike[],
  namespace: string,
  hasSavedNumber: boolean,
  applying: boolean,
): SignalBridgeStatus {
  if (applying) return "deploying";
  const dep = deployments.find(
    (d) =>
      d.metadata.name === SIGNAL_BRIDGE_NAME &&
      (d.metadata.namespace ?? "default") === namespace,
  );
  if (!dep) return "notDeployed";
  if ((dep.status?.readyReplicas ?? 0) < 1) return "starting";
  return hasSavedNumber ? "linked" : "ready";
}

/** Color token for the status dot (matches the Swift palette). */
export function signalStatusColor(
  status: SignalBridgeStatus,
): "gray" | "amber" | "blue" | "green" {
  switch (status) {
    case "notDeployed":
      return "gray";
    case "deploying":
    case "starting":
      return "amber";
    case "ready":
      return "blue";
    case "linked":
      return "green";
  }
}

/** Human-readable status label (mono font in the UI). */
export function signalStatusLabel(status: SignalBridgeStatus): string {
  switch (status) {
    case "notDeployed":
      return "Bridge not deployed";
    case "deploying":
      return "Deploying bridge…";
    case "starting":
      return "Bridge starting…";
    case "ready":
      return "Bridge ready — link a phone";
    case "linked":
      return "Linked";
  }
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

/**
 * Parse a comma-separated recipients string into a trimmed, non-empty list.
 * Whitespace around each entry is stripped and empties are dropped, so
 * "+1555, , +1666" → ["+1555", "+1666"].
 */
export function parseRecipients(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// assistant-config Signal keys
// ---------------------------------------------------------------------------

/** In-cluster API URL for the bridge in `namespace`. */
export function signalApiUrl(namespace: string): string {
  const ns = namespace.trim() || "default";
  return `http://signal-cli-rest.${ns}.svc.cluster.local:8080`;
}

/** The linked sender number stored in assistant-config (empty when unlinked). */
export function signalNumber(configData: Record<string, string>): string {
  return configData["signalNumber"] ?? "";
}

/** Saved recipients string from assistant-config (empty when unset). */
export function signalRecipients(configData: Record<string, string>): string {
  return configData["signalRecipients"] ?? "";
}

/** Two-way (inbound) flag from assistant-config; defaults to false. */
export function signalInbound(configData: Record<string, string>): boolean {
  return configData["signalInbound"] === "true";
}

/** True iff a non-empty sender number is saved (bridge is "linked"). */
export function hasSavedNumber(configData: Record<string, string>): boolean {
  return signalNumber(configData).trim() !== "";
}

/**
 * Build the `data` patch for a setSignal write. Only the provided fields are
 * included so the server's read-modify-write never clobbers unrelated keys
 * (mode/window/kill-switch live in the same ConfigMap).
 */
export function signalConfigUpdates(args: {
  apiUrl?: string;
  number?: string;
  recipients?: string;
  inbound?: boolean;
}): Record<string, string> {
  const out: Record<string, string> = {};
  if (args.apiUrl !== undefined) out["signalApiUrl"] = args.apiUrl;
  if (args.number !== undefined) out["signalNumber"] = args.number;
  if (args.recipients !== undefined) out["signalRecipients"] = args.recipients;
  if (args.inbound !== undefined) out["signalInbound"] = args.inbound ? "true" : "false";
  return out;
}
