// Port-forward client helpers — web side of docs/parity/portforward.md.
//
// Pure display + validation helpers for the Services-panel port-forward UI.
// The REST contract (POST /api/portforward) and the ActiveForward shape mirror
// the server module `apps/server/src/portForward.ts` exactly.

import type { Service } from "./types";

export type ForwardStatus = "starting" | "running" | "failed";

/** One active forward, as returned by POST /api/portforward { action:"list" }. */
export interface ActiveForward {
  id: string;
  namespace: string;
  service?: string;
  pod?: string;
  targetKind: "svc" | "pod";
  localPort: number;
  remotePort: number;
  status: ForwardStatus;
  failureMessage?: string;
  createdAt: number;
}

/**
 * Target label for a forward: `svc/name:remotePort` (or `pod/name:remotePort`).
 * Falls back to "?" when the name is missing so the row never renders blank.
 */
export function formatForwardLabel(forward: ActiveForward): string {
  const name = forward.targetKind === "svc" ? forward.service : forward.pod;
  return `${forward.targetKind}/${name ?? "?"}:${forward.remotePort}`;
}

/**
 * Service UIDs that have at least one RUNNING forward (for the row badge).
 * Matches a forward to a service by name + namespace; only "running" counts so
 * the badge does not flash for forwards still starting or already failed.
 */
export function getForwardingServices(
  forwards: ActiveForward[],
  services: Service[],
): Set<string> {
  const running = forwards.filter((f) => f.status === "running");
  const uids = new Set<string>();
  for (const svc of services) {
    const hit = running.some(
      (f) =>
        f.targetKind === "svc" &&
        f.service === svc.metadata.name &&
        f.namespace === (svc.metadata.namespace ?? "default"),
    );
    if (hit) uids.add(svc.metadata.uid);
  }
  return uids;
}

/** Default local-port suggestion: the remote port itself when known, else 8000. */
export function buildLocalPortDefault(remotePort?: number): number {
  return remotePort != null && remotePort >= 1 && remotePort <= 65535 ? remotePort : 8000;
}

/**
 * Validate a local-port string against the active forwards. Returns an inline
 * error message, or null when valid. Mirrors the dialog rules in the spec:
 *   - required, numeric integer
 *   - 1–65535
 *   - not already held by a non-failed forward
 */
export function validateLocalPort(
  value: string,
  activeForwards: ActiveForward[],
): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "Local port is required";
  if (!/^\d+$/.test(trimmed)) return "Local port must be a number";
  const port = Number(trimmed);
  if (port < 1 || port > 65535) return "Local port must be between 1 and 65535";
  const inUse = activeForwards.some((f) => f.status !== "failed" && f.localPort === port);
  if (inUse) return `Port ${port} is already in use by another forward`;
  return null;
}
