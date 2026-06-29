import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeFatalHandler } from "./fatalHandler";

describe("makeFatalHandler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs cleanup then exits non-zero, exactly once", async () => {
    const exit = vi.fn();
    const stopAll = vi.fn(() => Promise.resolve());
    makeFatalHandler(stopAll, exit, () => {})(new Error("boom"));

    await vi.advanceTimersByTimeAsync(2_500); // flush cleanup microtask + backstop timer
    expect(stopAll).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("still exits if cleanup never settles (timeout backstop)", async () => {
    const exit = vi.fn();
    const stopAll = vi.fn(() => new Promise<void>(() => {})); // never resolves
    makeFatalHandler(stopAll, exit, () => {})(new Error("boom"));

    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits even if cleanup rejects", async () => {
    const exit = vi.fn();
    const stopAll = vi.fn(() => Promise.reject(new Error("cleanup failed")));
    makeFatalHandler(stopAll, exit, () => {})(new Error("boom"));

    await vi.advanceTimersByTimeAsync(2_500);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("logs the fatal error", () => {
    const log = vi.fn();
    makeFatalHandler(() => Promise.resolve(), vi.fn(), log)(new Error("boom"));
    expect(log).toHaveBeenCalled();
  });
});
