/**
 * Ref-counted watch-subscription bookkeeping for the WebSocket layer.
 *
 * Panels call subscribe() on mount and unsubscribe() on unmount. Tab switches
 * unmount/remount panels, so a naive 1:1 subscribe/unsubscribe tears the watch
 * down and rebuilds it on every switch (full refetch + snapshot + loading
 * flash). Two mounted components watching the same kind/namespace would also
 * fight: the first to unmount would unsubscribe it out from under the other.
 *
 * This module owns the pure decision logic so it can be unit tested without a
 * socket. ws.ts holds the registry and turns these decisions into real effects
 * (send a frame, toggle store loading, arm/clear a linger timer).
 */

/** Grace period before an unused subscription is actually torn down. A quick
 *  tab switch re-subscribes within this window and reuses the warm watch. */
export const LINGER_MS = 30_000;

/** A live (or lingering) watch subscription, keyed by `${kind}/${namespace}`. */
export interface SubEntry {
  kind: string;
  namespace: string;
  /** Number of mounted components currently relying on this watch. */
  refs: number;
  /** Set while refs === 0 and we are waiting out the grace period. */
  lingerTimer?: ReturnType<typeof setTimeout>;
}

export type SubRegistry = Map<string, SubEntry>;

/** Registry key for a kind/namespace pair. */
export function subKey(kind: string, namespace: string): string {
  return `${kind}/${namespace}`;
}

/**
 * Decide what subscribe() should do for a kind/namespace given the current
 * registry. Mutates the registry (creates/revives the entry, bumps refs,
 * clears any pending linger) and reports the side effects ws.ts must run.
 *
 * - Existing entry (warm reuse): clear the linger timer, increment refs, send
 *   nothing and do not touch loading. The server is still subscribed and the
 *   store still holds the data, so a tab switch is instant.
 * - New entry (cold): create it with refs 1 and report that the caller should
 *   toggle loading on and send the subscribe frame.
 */
export function planSubscribe(
  registry: SubRegistry,
  kind: string,
  namespace: string,
): { sendSubscribe: boolean; toggleLoading: boolean; clearedTimer?: ReturnType<typeof setTimeout> } {
  const key = subKey(kind, namespace);
  const existing = registry.get(key);
  if (existing) {
    const clearedTimer = existing.lingerTimer;
    existing.lingerTimer = undefined;
    existing.refs += 1;
    return { sendSubscribe: false, toggleLoading: false, clearedTimer };
  }
  registry.set(key, { kind, namespace, refs: 1 });
  return { sendSubscribe: true, toggleLoading: true };
}

/**
 * Decide what unsubscribe() should do. Mutates the registry by decrementing
 * refs and reports whether ws.ts should arm the linger timer.
 *
 * - No entry: nothing to do.
 * - refs still > 0 after decrement: still in use, do nothing.
 * - refs hits 0: report startLinger so ws.ts arms a timer. When that timer
 *   fires it calls finishLinger() to delete the entry and send the frame.
 */
export function planUnsubscribe(
  registry: SubRegistry,
  kind: string,
  namespace: string,
): { startLinger: boolean } {
  const entry = registry.get(subKey(kind, namespace));
  if (!entry) return { startLinger: false };
  entry.refs -= 1;
  if (entry.refs > 0) return { startLinger: false };
  return { startLinger: true };
}

/**
 * Run when a linger timer fires. If the entry is still at refs 0 (no revive
 * happened during the grace period) delete it and report that the unsubscribe
 * frame should be sent. If it was revived, leave it and send nothing.
 */
export function finishLinger(
  registry: SubRegistry,
  kind: string,
  namespace: string,
): { sendUnsubscribe: boolean } {
  const key = subKey(kind, namespace);
  const entry = registry.get(key);
  if (!entry || entry.refs > 0) return { sendUnsubscribe: false };
  registry.delete(key);
  return { sendUnsubscribe: true };
}
