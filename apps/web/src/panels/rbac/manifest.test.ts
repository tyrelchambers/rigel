import { describe, expect, it } from "vitest";
import { buildBindingYaml, buildRoleYaml } from "./manifest";

describe("buildRoleYaml", () => {
  it("builds a namespaced Role with rules", () => {
    const yaml = buildRoleYaml(
      { kind: "Role", name: "reader", namespace: "default" },
      [{ apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] }],
    );
    expect(yaml).toBe(
      [
        "apiVersion: rbac.authorization.k8s.io/v1",
        "kind: Role",
        "metadata:",
        "  name: 'reader'",
        "  namespace: 'default'",
        "rules:",
        "  - apiGroups: ['']",
        "    resources: ['pods']",
        "    verbs: ['get', 'list']",
        "",
      ].join("\n"),
    );
  });

  it("omits namespace for a ClusterRole, carries labels, and empties rules", () => {
    const yaml = buildRoleYaml(
      { kind: "ClusterRole", name: "admin", labels: { team: "sre" } },
      [],
    );
    expect(yaml).toContain("kind: ClusterRole");
    expect(yaml).not.toContain("namespace:");
    expect(yaml).toContain("  labels:\n    'team': 'sre'");
    expect(yaml).toContain("rules: []");
  });

  it("defaults an empty apiGroups to the core group", () => {
    const yaml = buildRoleYaml({ kind: "Role", name: "r", namespace: "d" }, [
      { resources: ["pods"], verbs: ["get"] },
    ]);
    expect(yaml).toContain("apiGroups: ['']");
  });
});

describe("buildBindingYaml", () => {
  it("builds a RoleBinding with mixed subjects", () => {
    const yaml = buildBindingYaml(
      { kind: "RoleBinding", name: "b1", namespace: "default" },
      { kind: "ClusterRole", name: "admin" },
      [
        { kind: "ServiceAccount", name: "app", namespace: "default" },
        { kind: "Group", name: "system:masters" },
      ],
    );
    expect(yaml).toBe(
      [
        "apiVersion: rbac.authorization.k8s.io/v1",
        "kind: RoleBinding",
        "metadata:",
        "  name: 'b1'",
        "  namespace: 'default'",
        "roleRef:",
        "  apiGroup: rbac.authorization.k8s.io",
        "  kind: ClusterRole",
        "  name: 'admin'",
        "subjects:",
        "  - kind: ServiceAccount",
        "    name: 'app'",
        "    namespace: 'default'",
        "  - kind: Group",
        "    apiGroup: rbac.authorization.k8s.io",
        "    name: 'system:masters'",
        "",
      ].join("\n"),
    );
  });

  it("omits namespace for a ClusterRoleBinding and empties subjects", () => {
    const yaml = buildBindingYaml(
      { kind: "ClusterRoleBinding", name: "cb" },
      { kind: "ClusterRole", name: "view" },
      [],
    );
    expect(yaml).toContain("kind: ClusterRoleBinding");
    expect(yaml).not.toContain("namespace:");
    expect(yaml).toContain("subjects: []");
  });
});
