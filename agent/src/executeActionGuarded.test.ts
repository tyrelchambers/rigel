// agent/src/executeActionGuarded.test.ts
import { describe, test, expect, vi } from "vitest";
import { executeActionGuarded } from "./executeActionGuarded.js";
import { CircuitBreaker } from "./guardrails.js";

const cb = () => new CircuitBreaker({ maxPerResourcePerHour: 5, maxPerNight: 50, maxAttemptsPerIncident: 5, windowMs: 86_400_000 });
const action = { label: "restart api", kind: "restart", deployment: "api", namespace: "default" };

function deps(over = {}) {
  return {
    now: () => 1_000,
    execute: vi.fn(async () => ({ success: true, output: "restarted", backupYaml: "kind: Deployment", commands: ["kubectl rollout restart deployment/api -n default"] })),
    storeBackup: vi.fn(async () => "backup-1"),
    audit: vi.fn(async () => {}),
    ...over,
  };
}

describe("executeActionGuarded", () => {
  test("runs and returns a success reply", async () => {
    const d = deps();
    const reply = await executeActionGuarded(cb(), { action: action as any, fingerprint: "fp", resourceKey: "default/api" }, d);
    expect(reply).toMatch(/✓ Ran/);
    expect(d.execute).toHaveBeenCalled();
    expect(d.storeBackup).toHaveBeenCalled();
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ success: true, backupRef: "backup-1" }));
  });

  test("circuit-breaker denial short-circuits", async () => {
    const breaker = cb();
    for (let i = 0; i < 5; i++) breaker.record("fp", "default/api", 1_000);
    const d = deps();
    const reply = await executeActionGuarded(breaker, { action: action as any, fingerprint: "fp", resourceKey: "default/api" }, d);
    expect(reply).toMatch(/Can't run that right now/);
    expect(d.execute).not.toHaveBeenCalled();
  });
});
