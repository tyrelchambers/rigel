import { describe, it, expect } from "vitest";
import { mapPool } from "./pool.js";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("mapPool", () => {
  it("preserves input order regardless of completion order", async () => {
    const out = await mapPool([10, 20, 30], 3, async (n) => {
      await new Promise((r) => setTimeout(r, 30 - n)); // 30 finishes first
      return n * 2;
    });
    expect(out).toEqual([20, 40, 60]);
  });

  it("never runs more than `limit` tasks concurrently", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapPool([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n;
    });
    expect(out).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it("reaches the concurrency limit — real overlap, third waits for a slot", async () => {
    const items = [0, 1, 2];
    const startedFlags = items.map(() => deferred());
    const release = deferred();
    const p = mapPool(items, 2, async (i) => {
      startedFlags[i]!.resolve();
      await release.promise;
      return i;
    });
    // First two start immediately; the third must wait for a freed slot.
    await Promise.all([startedFlags[0]!.promise, startedFlags[1]!.promise]);
    let thirdStarted = false;
    void startedFlags[2]!.promise.then(() => (thirdStarted = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(thirdStarted).toBe(false);
    release.resolve();
    expect(await p).toEqual([0, 1, 2]);
  });

  it("handles an empty list", async () => {
    expect(await mapPool([], 3, async () => 1)).toEqual([]);
  });

  it("treats limit < 1 as serial", async () => {
    let peak = 0;
    let inFlight = 0;
    await mapPool([1, 2, 3], 0, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return n;
    });
    expect(peak).toBe(1);
  });
});
