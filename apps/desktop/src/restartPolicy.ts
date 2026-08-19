/**
 * Crash-loop guard for the desktop's forked children (the Rigel server and the
 * voice worker). Each is supervised and restarted when it dies unexpectedly,
 * but a child that crashes on startup must NOT be respawned in a hot loop. We
 * allow a handful of restarts inside a rolling window, then give up. Callers
 * keep their own crash list and pass their own limit; the policy is shared so
 * there is only ever one answer to "is this a crash loop".
 */
export interface RestartDecision {
  restart: boolean;
  /** Human-readable reason when restart is false. */
  reason?: string;
}

export function decideRestart(
  recentCrashes: number[],
  now: number,
  opts: { windowMs?: number; maxInWindow?: number } = {},
): RestartDecision {
  const windowMs = opts.windowMs ?? 30_000;
  const maxInWindow = opts.maxInWindow ?? 5;
  const recent = recentCrashes.filter((t) => now - t < windowMs);
  if (recent.length >= maxInWindow) {
    return {
      restart: false,
      reason: `crashed ${recent.length} times in ${Math.round(windowMs / 1000)}s`,
    };
  }
  return { restart: true };
}
