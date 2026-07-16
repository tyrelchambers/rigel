/** A per-key limiter callable; `size` exposes the live entry count. */
export interface RateLimiter {
  (key: string): boolean;
  readonly size: number;
}

/** Fixed-window per-key limiter. `now` is injectable for tests. Expired entries
 *  are swept at most once per window so a flood of distinct keys (e.g. random
 *  bearer tokens on a public route) can't grow memory without bound. */
export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now): RateLimiter {
  const hits = new Map<string, { count: number; reset: number }>();
  let nextSweep = 0;
  function allow(key: string): boolean {
    const t = now();
    if (t >= nextSweep) {
      for (const [k, v] of hits) if (t >= v.reset) hits.delete(k);
      nextSweep = t + windowMs;
    }
    const e = hits.get(key);
    if (!e || t >= e.reset) {
      hits.set(key, { count: 1, reset: t + windowMs });
      return true;
    }
    if (e.count >= limit) return false;
    e.count++;
    return true;
  }
  Object.defineProperty(allow, "size", { get: () => hits.size });
  return allow as RateLimiter;
}
