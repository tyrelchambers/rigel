/** Fixed-window per-key limiter. `now` is injectable for tests. */
export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, { count: number; reset: number }>();
  return function allow(key: string): boolean {
    const t = now();
    const e = hits.get(key);
    if (!e || t >= e.reset) {
      hits.set(key, { count: 1, reset: t + windowMs });
      return true;
    }
    if (e.count >= limit) return false;
    e.count++;
    return true;
  };
}
