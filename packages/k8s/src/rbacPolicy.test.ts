import { describe, test, expect } from "vitest";
import { cell, hasCell, toggleCell, serializePolicy, parsePolicy, type RbacPolicy } from "./rbacPolicy";

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
