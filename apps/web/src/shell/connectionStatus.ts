/**
 * Derive the status-bar connection label/tone from the live cluster store.
 *
 * The dot reflects the WebSocket transport to the local server, NOT a kubectl
 * command result. A dropped socket is retried forever (see lib/ws.ts), so it
 * reads as "reconnecting…" rather than the misleading "kubectl: error". A real
 * server-reported watch error (connected, but `error` set) is the only case
 * that surfaces as an actual error.
 */
export type ConnectionTone = "ok" | "warn" | "error";

export interface ConnectionStatus {
  label: string;
  tone: ConnectionTone;
}

export function connectionStatus(connected: boolean, error: string | null): ConnectionStatus {
  if (!connected) return { label: "reconnecting…", tone: "warn" };
  if (error) return { label: "kubectl: error", tone: "error" };
  return { label: "kubectl: ok", tone: "ok" };
}
