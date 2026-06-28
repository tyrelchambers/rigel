// Matrix channel — shared pure helpers (mirrors signal.ts). The byte-identical
// source of truth for the access-token Secret, the assistant-config Matrix keys,
// the config readers, and the connection status the web panel derives. No kubectl
// runs here — these are pure functions the web panel and the server both call.

/** Secret holding the bot access token, injected into the agent as
 *  MATRIX_ACCESS_TOKEN (see packages/k8s assistant deployment()). */
export const MATRIX_SECRET_NAME = "rigel-matrix-token";
/** Data key inside MATRIX_SECRET_NAME. */
export const MATRIX_ACCESS_TOKEN_KEY = "accessToken";

/** YAML-escape a token for a double-quoted stringData value. */
function escapeYaml(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** The Secret YAML for the bot access token. Applied via `kubectl apply -f -`;
 *  never previewed (carries the token). */
export function matrixSecretYAML(token: string, namespace = "default"): string {
  const ns = namespace.trim() || "default";
  return `apiVersion: v1
kind: Secret
metadata:
  name: ${MATRIX_SECRET_NAME}
  namespace: ${ns}
  labels:
    app.kubernetes.io/managed-by: rigel-assistant
type: Opaque
stringData:
  ${MATRIX_ACCESS_TOKEN_KEY}: "${escapeYaml(token)}"`;
}

/** Build the `data` patch for a setMatrix write. Only provided fields are
 *  included so the server's read-modify-write never clobbers unrelated keys. The
 *  access token is NOT here — it lives in the Secret. */
export function matrixConfigUpdates(args: {
  homeserverUrl?: string;
  userId?: string;
  roomId?: string;
  allowedSenders?: string;
  inbound?: boolean;
}): Record<string, string> {
  const out: Record<string, string> = {};
  if (args.homeserverUrl !== undefined) out["matrixHomeserverUrl"] = args.homeserverUrl;
  if (args.userId !== undefined) out["matrixUserId"] = args.userId;
  if (args.roomId !== undefined) out["matrixRoomId"] = args.roomId;
  if (args.allowedSenders !== undefined) out["matrixAllowedSenders"] = args.allowedSenders;
  if (args.inbound !== undefined) out["matrixInbound"] = args.inbound ? "true" : "false";
  return out;
}

export function matrixHomeserverUrl(d: Record<string, string>): string {
  return d["matrixHomeserverUrl"] ?? "";
}
export function matrixUserId(d: Record<string, string>): string {
  return d["matrixUserId"] ?? "";
}
export function matrixRoomId(d: Record<string, string>): string {
  return d["matrixRoomId"] ?? "";
}
export function matrixAllowedSenders(d: Record<string, string>): string {
  return d["matrixAllowedSenders"] ?? "";
}
export function matrixInbound(d: Record<string, string>): boolean {
  return d["matrixInbound"] === "true";
}

/** Parse a comma/newline-separated allowed-senders string into a trimmed list. */
export function parseAllowedSenders(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Connected once a homeserver, bot id, and room are all saved. */
export function deriveMatrixConnected(d: Record<string, string>): boolean {
  return (
    matrixHomeserverUrl(d).trim() !== "" &&
    matrixUserId(d).trim() !== "" &&
    matrixRoomId(d).trim() !== ""
  );
}

/** UI status: connected/notConnected derive from config; connecting/error are
 *  transient wizard states owned by the component. */
export type MatrixStatus = "notConnected" | "connecting" | "connected" | "error";

export function matrixStatusColor(s: MatrixStatus): "gray" | "amber" | "green" | "red" {
  switch (s) {
    case "notConnected":
      return "gray";
    case "connecting":
      return "amber";
    case "connected":
      return "green";
    case "error":
      return "red";
  }
}

export function matrixStatusLabel(s: MatrixStatus): string {
  switch (s) {
    case "notConnected":
      return "Not connected";
    case "connecting":
      return "Connecting…";
    case "connected":
      return "Connected";
    case "error":
      return "Connection error";
  }
}
