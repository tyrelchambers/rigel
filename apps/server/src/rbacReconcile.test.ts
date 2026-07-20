import { test, expect, vi } from "vitest";
import { reconcileRbac } from "./assistant";
import { DEFAULT_POLICY, clusterRoleRules, serializePolicy, setCapability } from "@rigel/k8s";

const ok = async () => ({ code: 0, stdout: "configured", stderr: "" });

function deps(over: Partial<Parameters<typeof reconcileRbac>[0]> = {}) {
  return {
    discover: async () => ["ctx-a"],
    readConfig: async () => ({ rbacPolicy: serializePolicy(DEFAULT_POLICY) }),
    readLive: async () => clusterRoleRules(DEFAULT_POLICY) as unknown[],
    apply: vi.fn(ok),
    ...over,
  };
}

test("skips a context with no stored policy — never enforces DEFAULT blindly", async () => {
  const d = deps({ readConfig: async () => ({}) });
  const res = await reconcileRbac(d);
  expect(d.apply).not.toHaveBeenCalled();
  expect(res.healed).toEqual([]);
});

test("skips when the live ClusterRole already matches the stored policy", async () => {
  const d = deps();
  const res = await reconcileRbac(d);
  expect(d.apply).not.toHaveBeenCalled();
  expect(res.healed).toEqual([]);
});

test("heals a drifted ClusterRole back to the stored policy", async () => {
  const d = deps({ readLive: async () => [] }); // live lost all rules → drift
  const res = await reconcileRbac(d);
  expect(d.apply).toHaveBeenCalledTimes(1);
  expect(d.apply.mock.calls[0][0]).toBe("ctx-a");
  expect(res.healed).toEqual(["ctx-a"]);
});

test("stored exec grant is re-asserted when the live role dropped it", async () => {
  const stored = setCapability(DEFAULT_POLICY, "exec", true);
  const d = deps({
    readConfig: async () => ({ rbacPolicy: serializePolicy(stored) }),
    readLive: async () => clusterRoleRules(DEFAULT_POLICY) as unknown[], // exec missing
  });
  const res = await reconcileRbac(d);
  expect(d.apply).toHaveBeenCalledTimes(1);
  expect(d.apply.mock.calls[0][1]).toMatch(/pods\/exec/);
  expect(res.healed).toEqual(["ctx-a"]);
});

test("never heals blind on an unreadable live role (null)", async () => {
  const d = deps({ readLive: async () => null });
  const res = await reconcileRbac(d);
  expect(d.apply).not.toHaveBeenCalled();
  expect(res.healed).toEqual([]);
});
