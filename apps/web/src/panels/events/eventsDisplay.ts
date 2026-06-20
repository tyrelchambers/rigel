import type { EventBucket, EventTypeFilter, K8sEvent } from "./types";

/**
 * Pure display helpers for the Events panel. Mirrors the Swift `K8sEvent`
 * computed properties (`isWarning`, `when`, `relativeAge(now:)`) and
 * `EventsViewModel` derivations, plus `Viz.eventBuckets` from
 * `Sources/Rigel/Charts/Aggregations.swift`. See `docs/parity/events.md`.
 *
 * All time-dependent helpers accept a `now` parameter (epoch ms) for test
 * determinism, mirroring the Swift `func relativeAge(now: Date = Date())`.
 */

/** `event.type === "Warning"`. Mirrors Swift `K8sEvent.isWarning`. */
export function isWarning(event: K8sEvent): boolean {
  return event.type === "Warning";
}

/**
 * Best timestamp for an event: `lastTimestamp ?? firstTimestamp ??
 * metadata.creationTimestamp`. Mirrors Swift `K8sEvent.when`.
 */
export function when(event: K8sEvent): string | undefined {
  return (
    event.lastTimestamp ??
    event.firstTimestamp ??
    event.metadata.creationTimestamp ??
    undefined
  );
}

/**
 * Relative age string ("5s", "3m", "2h", "1d"). Returns "—" when the timestamp
 * is missing or unparseable, "0s" for future timestamps. Pass `now` (epoch ms)
 * for determinism; defaults to `Date.now()` in production. Mirrors the Swift
 * `K8sEvent.relativeAge(now:)` and the shared web `relativeAge`.
 */
export function relativeAge(iso: string | undefined | null, now: number = Date.now()): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const dt = (now - then) / 1000; // seconds
  if (dt < 0) return "0s";
  if (dt < 60) return `${Math.floor(dt)}s`;
  if (dt < 3600) return `${Math.floor(dt / 60)}m`;
  if (dt < 86400) return `${Math.floor(dt / 3600)}h`;
  return `${Math.floor(dt / 86400)}d`;
}

/**
 * Absolute timestamp for the Age tooltip, e.g. "Jun 1, 2026, 8:14:02 AM".
 * Returns null when the timestamp is missing or unparseable.
 */
export function absoluteWhen(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "medium" });
}

/**
 * Tailwind classes for the Type badge. Warning → red/destructive, Normal (and
 * everything else, including nil) → green/success. Mirrors the Swift
 * `Theme.Status.failed` / `Theme.Status.running` mapping.
 */
export function typeColorClass(type: string | null | undefined): string {
  return type === "Warning"
    ? "text-red-600 bg-red-600/15"
    : "text-green-600 bg-green-600/15";
}

/**
 * Case-insensitive substring match across `reason`, `message`, and
 * `involvedObject.name`. Empty/blank query matches everything. Mirrors
 * `EventsViewModel.filteredEvents` (`localizedCaseInsensitiveContains`).
 */
export function matchesSearch(event: K8sEvent, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const fields: string[] = [
    event.reason ?? "",
    event.message ?? "",
    event.involvedObject?.name ?? "",
  ];
  return fields.some((f) => f.toLowerCase().includes(q));
}

/**
 * True when the event passes the type filter. "All" matches everything,
 * "Warning" matches `type === "Warning"`, "Normal" matches `type === "Normal"`.
 * Mirrors `EventsViewModel` filter logic in `docs/parity/events.md`.
 */
export function matchesTypeFilter(event: K8sEvent, filter: EventTypeFilter): boolean {
  if (filter === "All") return true;
  if (filter === "Warning") return event.type === "Warning";
  return event.type === "Normal";
}

/**
 * Sort events newest-first by `lastTimestamp ?? firstTimestamp ??
 * creationTimestamp`. Events with no usable timestamp sort to the bottom
 * (treated as the distant past). Mirrors `ClusterCache.applyEvent()` which
 * keeps `events.sort { ($0.when ?? .distantPast) > ($1.when ?? .distantPast) }`.
 */
export function sortEvents(events: K8sEvent[]): K8sEvent[] {
  const key = (e: K8sEvent): number => {
    const w = when(e);
    if (!w) return Number.NEGATIVE_INFINITY;
    const t = Date.parse(w);
    return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
  };
  return [...events].sort((a, b) => key(b) - key(a));
}

/**
 * Partition events into `count` equal slots spanning `[now - span, now]`.
 * Events without a usable timestamp or outside the window are dropped; an
 * event exactly at `now` lands in the final bucket. `now` and the returned
 * `start` are epoch milliseconds; `span` is in SECONDS (to match the Swift
 * `TimeInterval` call site `eventBuckets(events, now, span: 3600, count: 60)`).
 * Mirrors `Viz.eventBuckets` in `Sources/Rigel/Charts/Aggregations.swift`.
 */
export function eventBuckets(
  events: K8sEvent[],
  now: number,
  span: number,
  count: number,
): EventBucket[] {
  if (count <= 0 || span <= 0) return [];
  const spanMs = span * 1000;
  const slotMs = spanMs / count;
  const start = now - spanMs;
  const buckets: EventBucket[] = Array.from({ length: count }, (_, i) => ({
    index: i,
    start: start + i * slotMs,
    warnings: 0,
    normal: 0,
  }));
  for (const e of events) {
    const w = when(e);
    if (!w) continue;
    const t = Date.parse(w);
    if (Number.isNaN(t) || t < start || t > now) continue;
    let idx = Math.floor((t - start) / slotMs);
    if (idx >= count) idx = count - 1;
    if (idx < 0) idx = 0;
    if (isWarning(e)) buckets[idx].warnings += 1;
    else buckets[idx].normal += 1;
  }
  return buckets;
}
