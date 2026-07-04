import { describe, expect, it } from "vitest";
import { buildDeleteAction } from "./rbacActions";

describe("buildDeleteAction", () => {
  it("builds a namespaced role delete", () => {
    expect(buildDeleteAction("role", "reader", "default")).toEqual({
      kind: "deleteResource",
      resourceKind: "role",
      name: "reader",
      namespace: "default",
      destructive: true,
      label: "Delete role reader",
    });
  });
  it("omits namespace for a clusterrole", () => {
    expect(buildDeleteAction("clusterrole", "admin")).toEqual({
      kind: "deleteResource",
      resourceKind: "clusterrole",
      name: "admin",
      destructive: true,
      label: "Delete clusterrole admin",
    });
  });
});
