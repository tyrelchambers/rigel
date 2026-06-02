/**
 * Map over `items` running at most `limit` calls concurrently, returning results
 * in INPUT order regardless of completion order. A small dependency-free fan-out
 * primitive for overlapping independent I/O (e.g. per-incident model calls)
 * without unbounded concurrency hammering a rate-limited API.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  const results = new Array<R>(n);
  const max = Math.max(1, Math.min(Math.floor(limit), n || 1));
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= n) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: max }, () => worker()));
  return results;
}
