// Pure display helpers for the Assistant panel (port of the Swift formatting
// helpers in AssistantPanel.swift). Kept separate from the component so they can
// be unit-tested without a DOM.

import type { TokenExpiryStatus } from "@rigel/k8s";
import { compactAge } from "@/lib/time";

/** Summary-strip / credentials token label. */
export function tokenLabel(t: TokenExpiryStatus): string {
  switch (t.level) {
    case "expired":
      return "expired — re-run setup-token";
    case "warning":
    case "ok":
      return `${t.daysRemaining}d left`;
  }
}

/** Tailwind text color for a token-expiry level. */
export function tokenColorClass(level: TokenExpiryStatus["level"]): string {
  switch (level) {
    case "ok":
      return "text-muted-foreground";
    case "warning":
      return "text-amber-600 dark:text-amber-400";
    case "expired":
      return "text-red-600 dark:text-red-400";
  }
}

/** Audit outcome glyph (✓ / ✗ / ▸ / •). */
export function outcomeGlyph(outcome: string): string {
  switch (outcome) {
    case "success":
      return "✓";
    case "failure":
      return "✗";
    case "queued":
      return "▸";
    default:
      return "•";
  }
}

/** Tailwind text color for an audit outcome. */
export function outcomeColorClass(outcome: string): string {
  switch (outcome) {
    case "success":
      return "text-green-600 dark:text-green-400";
    case "failure":
      return "text-red-600 dark:text-red-400";
    case "queued":
      return "text-amber-600 dark:text-amber-400";
    default:
      return "text-muted-foreground";
  }
}

/**
 * An audit row expands when it has hidden content: a stored analysis, or a
 * detail long enough to be clamped (mirrors Swift `canExpand`).
 */
export function auditCanExpand(detail: string, analysis: string | undefined): boolean {
  return (analysis?.length ?? 0) > 0 || detail.length > 160;
}

/** Compact relative time from an ISO-8601 string, tolerating fractional seconds. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  // clampFuture reproduces the original's `Math.max(0, …)` on the seconds bucket.
  return compactAge(iso, { now, invalid: "", clampFuture: true });
}

/** Count audit entries with a given outcome. */
export function auditCount(audit: Array<{ outcome: string }>, outcome: string): number {
  return audit.filter((e) => e.outcome === outcome).length;
}
