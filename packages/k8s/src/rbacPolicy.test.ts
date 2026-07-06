import { describe, test, expect } from "vitest";
import { cell, hasCell, toggleCell, serializePolicy, parsePolicy, type RbacPolicy } from "./rbacPolicy";
import { CAPABILITIES, DEFAULT_POLICY, capabilityState, setCapability } from "./rbacPolicy";
import { policyToClusterRoleRules, diffPolicies } from "./rbacPolicy";
import { isBaselineReadCell, subtractBaseline } from "./rbacPolicy";

const empty: RbacPolicy = { cells: [] };

describe("cell primitives", () => {
  test("cell encodes apiGroup/resource/verb; core group is empty string", () => {
    expect(cell("", "pods", "get")).toBe("|pods|get");
    expect(cell("apps", "deployments", "patch")).toBe("apps|deployments|patch");
  });
  test("toggleCell adds and removes, stays sorted + deduped", () => {
    let p = toggleCell(empty, cell("", "pods", "delete"), true);
    p = toggleCell(p, cell("apps", "deployments", "patch"), true);
    p = toggleCell(p, cell("", "pods", "delete"), true); // idempotent add
    expect(p.cells).toEqual(["apps|deployments|patch", "|pods|delete"]);
    expect(hasCell(p, cell("", "pods", "delete"))).toBe(true);
    p = toggleCell(p, cell("", "pods", "delete"), false);
    expect(hasCell(p, cell("", "pods", "delete"))).toBe(false);
  });
  test("serialize/parse round-trips and drops unknown/unrepresentable cells", () => {
    const p: RbacPolicy = { cells: [cell("", "pods", "delete"), cell("rbac.authorization.k8s.io", "roles", "create")] };
    const parsed = parsePolicy(serializePolicy(p));
    // roles are not representable → filtered on parse (no self-escalation)
    expect(parsed.cells).toEqual([cell("", "pods", "delete")]);
  });
});

describe("capabilities", () => {
  test("DEFAULT_POLICY = reversible + pod-delete + node-patch; read is baseline; destructive off", () => {
    expect(capabilityState(DEFAULT_POLICY, "read")).toBe("off"); // reads are baseline now, not policy cells
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

describe("read baseline floor", () => {
  test("DEFAULT_POLICY no longer contains read cells", () => {
    // Reads ship as the non-editable baseline, not as policy cells.
    expect(DEFAULT_POLICY.cells.some((c) => isBaselineReadCell(c))).toBe(false);
  });

  test("isBaselineReadCell matches get/list/watch on baseline-covered resources only", () => {
    expect(isBaselineReadCell(cell("", "pods", "get"))).toBe(true);
    expect(isBaselineReadCell(cell("apps", "deployments", "watch"))).toBe(true);
    expect(isBaselineReadCell(cell("", "pods", "delete"))).toBe(false); // write verb
    expect(isBaselineReadCell(cell("", "secrets", "get"))).toBe(false); // secrets never baseline
    expect(isBaselineReadCell(cell("", "nodes", "patch"))).toBe(false); // cordon, editable
  });

  test("subtractBaseline drops baseline read cells, keeps the rest", () => {
    const p = { cells: [cell("", "pods", "get"), cell("", "pods", "delete")].sort() };
    expect(subtractBaseline(p).cells).toEqual([cell("", "pods", "delete")]);
  });
});
