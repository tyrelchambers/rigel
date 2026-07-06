import { describe, test, expect } from "vitest";
import { cell, hasCell, toggleCell, serializePolicy, parsePolicy, type RbacPolicy } from "./rbacPolicy";
import { CAPABILITIES, DEFAULT_POLICY, capabilityState, setCapability } from "./rbacPolicy";
import { policyToClusterRoleRules, diffPolicies } from "./rbacPolicy";

const empty: RbacPolicy = { cells: [] };

describe("cell primitives", () => {
  test("cell encodes apiGroup/resource/verb; core group is empty string", () => {
    expect(cell("", "pods", "get")).toBe("|pods|get");
    expect(cell("apps", "deployments", "patch")).toBe("apps|deployments|patch");
  });
  test("toggleCell adds and removes, stays sorted + deduped", () => {
    let p = toggleCell(empty, cell("", "pods", "get"), true);
    p = toggleCell(p, cell("apps", "deployments", "patch"), true);
    p = toggleCell(p, cell("", "pods", "get"), true); // idempotent add
    expect(p.cells).toEqual(["apps|deployments|patch", "|pods|get"]);
    expect(hasCell(p, cell("", "pods", "get"))).toBe(true);
    p = toggleCell(p, cell("", "pods", "get"), false);
    expect(hasCell(p, cell("", "pods", "get"))).toBe(false);
  });
  test("serialize/parse round-trips and drops unknown/unrepresentable cells", () => {
    const p: RbacPolicy = { cells: [cell("", "pods", "get"), cell("rbac.authorization.k8s.io", "roles", "create")] };
    const parsed = parsePolicy(serializePolicy(p));
    // roles are not representable → filtered on parse (no self-escalation)
    expect(parsed.cells).toEqual([cell("", "pods", "get")]);
  });
});

describe("capabilities", () => {
  test("DEFAULT_POLICY = read + reversible + pod-delete + node-patch (destructive off)", () => {
    expect(capabilityState(DEFAULT_POLICY, "read")).toBe("on");
    expect(capabilityState(DEFAULT_POLICY, "reversible")).toBe("on");
    expect(capabilityState(DEFAULT_POLICY, "deletePods")).toBe("on");
    expect(capabilityState(DEFAULT_POLICY, "cordon")).toBe("on");
    expect(capabilityState(DEFAULT_POLICY, "deleteWorkloads")).toBe("off");
    expect(capabilityState(DEFAULT_POLICY, "drain")).toBe("off");
    expect(capabilityState(DEFAULT_POLICY, "secrets")).toBe("off");
  });
  test("setCapability toggles all of a capability's cells", () => {
    const p = setCapability(DEFAULT_POLICY, "deleteWorkloads", true);
    expect(capabilityState(p, "deleteWorkloads")).toBe("on");
    const off = setCapability(p, "deleteWorkloads", false);
    expect(capabilityState(off, "deleteWorkloads")).toBe("off");
  });
  test("partial state when only some cells are present", () => {
    const cap = CAPABILITIES.find((c) => c.id === "reversible")!;
    const partial: RbacPolicy = { cells: [cap.cells[0]] };
    expect(capabilityState(partial, "reversible")).toBe("partial");
  });
});

describe("render + diff", () => {
  test("policyToClusterRoleRules groups cells by apiGroup+verbset into rules", () => {
    const p: RbacPolicy = { cells: [cell("", "pods", "get"), cell("", "pods", "delete"), cell("apps", "deployments", "patch")] };
    const rules = policyToClusterRoleRules(p);
    // pods: {get,delete}; apps/deployments: {patch}. Order stable + sorted.
    expect(rules).toContainEqual({ apiGroups: [""], resources: ["pods"], verbs: ["delete", "get"] });
    expect(rules).toContainEqual({ apiGroups: ["apps"], resources: ["deployments"], verbs: ["patch"] });
  });
  test("diffPolicies returns added and removed cells", () => {
    const a: RbacPolicy = { cells: [cell("", "pods", "get")] };
    const b: RbacPolicy = { cells: [cell("", "pods", "get"), cell("apps", "deployments", "delete")] };
    const d = diffPolicies(a, b);
    expect(d.added).toEqual([cell("apps", "deployments", "delete")]);
    expect(d.removed).toEqual([]);
  });
});
