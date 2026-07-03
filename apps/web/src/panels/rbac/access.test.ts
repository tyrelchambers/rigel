import { describe, expect, it } from "vitest";
import {
  subjectKey,
  collectSubjects,
  effectiveGrants,
  subjectsForRole,
  rbacCounts,
} from "./access";
import type { Role, ClusterRole, RoleBinding, ClusterRoleBinding } from "./types";

const role = (name: string, ns: string, rules: any[]): Role => ({
  metadata: { name, namespace: ns },
  rules,
});
const clusterRole = (name: string, rules: any[]): ClusterRole => ({
  metadata: { name },
  rules,
});
const rb = (
  name: string,
  ns: string,
  roleRef: { kind: string; name: string },
  subjects: any[],
): RoleBinding => ({ metadata: { name, namespace: ns }, roleRef, subjects });
const crb = (
  name: string,
  roleRef: { kind: string; name: string },
  subjects: any[],
): ClusterRoleBinding => ({ metadata: { name }, roleRef, subjects });

const saAgent = { kind: "ServiceAccount", name: "rigel-agent", namespace: "default" };
const groupMasters = { kind: "Group", name: "system:masters" };

describe("subjectKey", () => {
  it("distinguishes SA namespace from users/groups", () => {
    expect(subjectKey(saAgent)).not.toBe(
      subjectKey({ kind: "ServiceAccount", name: "rigel-agent", namespace: "kube-system" }),
    );
    expect(subjectKey(groupMasters)).toBe(subjectKey({ kind: "Group", name: "system:masters" }));
  });
});

describe("effectiveGrants", () => {
  const roles = [role("reader", "default", [{ verbs: ["get"], resources: ["pods"] }])];
  const clusterRoles = [clusterRole("admin", [{ verbs: ["*"], resources: ["*"] }])];
  const roleBindings = [rb("b1", "default", { kind: "Role", name: "reader" }, [saAgent])];
  const clusterRoleBindings = [
    crb("cadmin", { kind: "ClusterRole", name: "admin" }, [saAgent]),
  ];

  it("resolves rules across RoleBinding and ClusterRoleBinding for a subject", () => {
    const grants = effectiveGrants(
      subjectKey(saAgent),
      roleBindings,
      clusterRoleBindings,
      roles,
      clusterRoles,
    );
    expect(grants).toHaveLength(2);
    const ns = grants.find((g) => g.bindingKind === "RoleBinding")!;
    expect(ns.scope).toEqual({ kind: "Namespaced", namespace: "default" });
    expect(ns.rules).toEqual([{ verbs: ["get"], resources: ["pods"] }]);
    const cluster = grants.find((g) => g.bindingKind === "ClusterRoleBinding")!;
    expect(cluster.scope).toEqual({ kind: "Cluster" });
    expect(cluster.rules).toEqual([{ verbs: ["*"], resources: ["*"] }]);
  });

  it("resolves a namespaced Role only in its own namespace", () => {
    const grants = effectiveGrants(
      subjectKey({ kind: "ServiceAccount", name: "rigel-agent", namespace: "other" }),
      [rb("b2", "other", { kind: "Role", name: "reader" }, [
        { kind: "ServiceAccount", name: "rigel-agent", namespace: "other" },
      ])],
      [],
      roles, // "reader" only exists in "default"
      [],
    );
    expect(grants).toHaveLength(1);
    expect(grants[0].rules).toEqual([]); // no matching Role in "other" ns
  });
});

describe("subjectsForRole (reverse)", () => {
  it("lists subjects bound to a clusterrole", () => {
    const result = subjectsForRole(
      { kind: "ClusterRole", name: "admin" },
      [],
      [crb("cadmin", { kind: "ClusterRole", name: "admin" }, [saAgent, groupMasters])],
    );
    expect(result.map((s) => s.subject.name).sort()).toEqual(["rigel-agent", "system:masters"]);
  });
});

describe("collectSubjects", () => {
  it("dedupes subjects across bindings and flags dangerous ones", () => {
    const roles = [role("reader", "default", [{ verbs: ["get"], resources: ["pods"] }])];
    const clusterRoles = [clusterRole("admin", [{ verbs: ["*"], resources: ["*"] }])];
    const subjects = collectSubjects(
      [rb("b1", "default", { kind: "Role", name: "reader" }, [saAgent])],
      [crb("cadmin", { kind: "ClusterRole", name: "admin" }, [saAgent, groupMasters])],
      roles,
      clusterRoles,
    );
    expect(subjects).toHaveLength(2); // saAgent deduped
    const agent = subjects.find((s) => s.name === "rigel-agent")!;
    expect(agent.dangerous).toBe(true); // bound to cluster admin
    const masters = subjects.find((s) => s.name === "system:masters")!;
    expect(masters.dangerous).toBe(true);
  });
});

describe("rbacCounts", () => {
  it("counts subjects, roles, bindings, and dangerous subjects", () => {
    const roles = [role("reader", "default", [{ verbs: ["get"], resources: ["pods"] }])];
    const clusterRoles = [clusterRole("admin", [{ verbs: ["*"], resources: ["*"] }])];
    const roleBindings = [rb("b1", "default", { kind: "Role", name: "reader" }, [saAgent])];
    const clusterRoleBindings = [crb("cadmin", { kind: "ClusterRole", name: "admin" }, [groupMasters])];
    const counts = rbacCounts(roleBindings, clusterRoleBindings, roles, clusterRoles);
    expect(counts).toEqual({ subjects: 2, roles: 2, bindings: 2, dangerous: 1 });
  });
});
