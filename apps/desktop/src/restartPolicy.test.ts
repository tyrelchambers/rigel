import { describe, it, expect } from "vitest";
import { decideRestart } from "./restartPolicy";

describe("decideRestart", () => {
  it("restarts when there have been few recent crashes", () => {
    expect(decideRestart([], 10_000).restart).toBe(true);
    expect(decideRestart([9_000, 9_500], 10_000).restart).toBe(true);
  });

  it("stops restarting after too many crashes inside the window (crash loop)", () => {
    const crashes = [1_000, 2_000, 3_000, 4_000, 5_000]; // 5 within 30s of now
    const decision = decideRestart(crashes, 6_000);
    expect(decision.restart).toBe(false);
    expect(decision.reason).toContain("5");
  });

  it("ignores crashes older than the window", () => {
    // Four ancient crashes, nothing recent → a fresh crash should still restart.
    expect(decideRestart([1, 2, 3, 4], 100_000).restart).toBe(true);
  });

  it("honors custom window / max overrides", () => {
    expect(decideRestart([1_000, 1_500], 2_000, { maxInWindow: 2 }).restart).toBe(false);
    expect(decideRestart([1_000, 1_500], 2_000, { maxInWindow: 3 }).restart).toBe(true);
  });
});
