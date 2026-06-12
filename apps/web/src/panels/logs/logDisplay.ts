// Display + filtering logic for the Logs panel. Pure functions (no React) so
// they're unit-testable. The color assigner + probe filter + line parser are
// shared with the server via @helmsman/k8s; this module wraps them with the
// web-side LogLine model (stable `id`), the 5000-line buffer cap, the
// filter pipeline, timestamp formatting, and sidebar helpers.
//
// Mirrors docs/parity/logs.md (Swift LogLine / PodColorAssigner / LogNoiseFilter).

import {
  POD_COLORS,
  parseLogLine,
  isProbeLine,
  isErrorLine,
  fnv1aColorIndex,
  deploymentColorIndex,
} from "@helmsman/k8s";
import type { Deployment } from "../deployments/types";

export { POD_COLORS, isProbeLine, isErrorLine, fnv1aColorIndex, deploymentColorIndex };

/** Max retained lines; oldest are dropped past this cap (mirrors Swift maxLines). */
export const MAX_LINES = 5000;

/** A rendered log line. `id` is unique per line instance (parse time). */
export interface LogLine {
  id: string;
  sourcePod: string;
  timestamp: Date | null;
  text: string;
  colorIndex: number; // 0-7
}

/** Hex color for a pod, via the shared FNV-1a palette index. */
export function podColor(podName: string): string {
  return POD_COLORS[fnv1aColorIndex(podName)];
}

/** Hex accent color for a sidebar deployment row, keyed on "namespace/name". */
export function deploymentColor(namespace: string, name: string): string {
  return POD_COLORS[deploymentColorIndex(namespace, name)];
}

/**
 * Parse one raw kubectl line into a LogLine with a fresh unique id. Uses
 * `crypto.randomUUID` when available, else a monotonic counter fallback.
 */
let _counter = 0;
function nextId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  _counter += 1;
  return `line-${_counter}`;
}

/** Build a LogLine (with id) from a raw kubectl `--prefix --timestamps` line. */
export function toLogLine(raw: string): LogLine {
  const p = parseLogLine(raw);
  return {
    id: nextId(),
    sourcePod: p.sourcePod,
    timestamp: p.timestamp,
    text: p.text,
    colorIndex: p.colorIndex,
  };
}

/**
 * Append `incoming` to `lines`, capping at MAX_LINES (drop oldest). Returns a
 * NEW array (never mutates the input) so React state updates are seen.
 */
export function appendLines(lines: LogLine[], incoming: LogLine[]): LogLine[] {
  const next = incoming.length === 1 ? [...lines, incoming[0]] : [...lines, ...incoming];
  if (next.length > MAX_LINES) return next.slice(next.length - MAX_LINES);
  return next;
}

/**
 * Apply the probe filter (when `hideProbes`) and the case-insensitive substring
 * `filter` (when non-empty). Both predicates are independent; order is
 * irrelevant. Mirrors the Swift `filteredLines` computed property.
 */
export function filterLines(lines: LogLine[], filter: string, hideProbes: boolean): LogLine[] {
  const needle = filter.trim().toLowerCase();
  return lines.filter((l) => {
    if (hideProbes && isProbeLine(l.text)) return false;
    if (needle && !l.text.toLowerCase().includes(needle)) return false;
    return true;
  });
}

/**
 * Stable sort by parsed timestamp ascending, so lines from multiple replicas
 * (whose initial `--tail` batches arrive grouped per-pod) are merged into one
 * chronological stream. JS sort is stable, so same-timestamp lines keep arrival
 * order; lines with no timestamp sort to the end (kept in arrival order).
 */
export function sortByTimestamp(lines: LogLine[]): LogLine[] {
  return [...lines].sort((a, b) => {
    const ta = a.timestamp ? a.timestamp.getTime() : Number.POSITIVE_INFINITY;
    const tb = b.timestamp ? b.timestamp.getTime() : Number.POSITIVE_INFINITY;
    return ta - tb;
  });
}

/** Format a parsed timestamp as "HH:MM:SS" (24h, local). "" when null. */
export function formatTimestamp(ts: Date | null): string {
  if (!ts) return "";
  const hh = String(ts.getHours()).padStart(2, "0");
  const mm = String(ts.getMinutes()).padStart(2, "0");
  const ss = String(ts.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// --- Sidebar (deployment list) helpers -------------------------------------

/** Stable key for a deployment row / selection: "namespace/name". */
export function deploymentKey(d: Deployment): string {
  return `${d.metadata.namespace ?? "default"}/${d.metadata.name}`;
}

/**
 * Sort deployments by namespace, then by name (mirrors the Swift sidebar order).
 */
export function sortDeployments(ds: Deployment[]): Deployment[] {
  return [...ds].sort((a, b) => {
    const an = a.metadata.namespace ?? "default";
    const bn = b.metadata.namespace ?? "default";
    if (an !== bn) return an.localeCompare(bn);
    return a.metadata.name.localeCompare(b.metadata.name);
  });
}

/** "ready/total" replica string for a sidebar row. */
export function replicaText(d: Deployment): string {
  const ready = d.status?.readyReplicas ?? 0;
  const total = d.status?.replicas ?? d.spec?.replicas ?? 0;
  return `${ready}/${total}`;
}

/** True when readyReplicas < total (sidebar shows replica text in red). */
export function replicasUnhealthy(d: Deployment): boolean {
  const ready = d.status?.readyReplicas ?? 0;
  const total = d.status?.replicas ?? d.spec?.replicas ?? 0;
  return ready < total;
}

/**
 * The `-l key=val,key=val` selector string from spec.selector.matchLabels,
 * sorted by key. Returns null when there are no matchLabels (the panel then
 * shows the "deployment has no spec.selector.matchLabels" error).
 */
export function labelSelector(d: Deployment): string | null {
  const labels = d.spec?.selector?.matchLabels ?? {};
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return null;
  return keys.map((k) => `${k}=${labels[k]}`).join(",");
}

/**
 * Context window for "Ask Claude about this line": the selected line plus up to
 * 5 lines before and 5 after (11 total) from the FULL line list (not filtered).
 */
export function lineContext(lines: LogLine[], lineId: string): LogLine[] {
  const idx = lines.findIndex((l) => l.id === lineId);
  if (idx < 0) return [];
  const start = Math.max(0, idx - 5);
  const end = Math.min(lines.length, idx + 6); // inclusive of +5
  return lines.slice(start, end);
}
