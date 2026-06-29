/**
 * Crash-loop guard for the forked Rigel server. The desktop supervises the
 * server child and restarts it when it dies unexpectedly, but a server that
 * crashes on startup must NOT be respawned in a hot loop. We allow a handful of
 * restarts inside a rolling window, then give up and surface the failure.
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
