import { describe, expect, test } from "vitest";
import type { ObjectMeta, PolicyRule, Subject } from "../types";
import {
  subjectsSummary,
  rulesSummary,
  matchesSearch,
  sortByNamespaceName,
  sortByName,
} from "../rbacDisplay";

describe("subjectsSummary", () => {
  test("returns 'no subjects' for undefined/empty", () => {
    expect(subjectsSummary(undefined)).toBe("no subjects");
    expect(subjectsSummary([])).toBe("no subjects");
  });

  test("formats a single ServiceAccount with namespace as sa:ns/name", () => {
    const subjects: Subject[] = [
      { kind: "ServiceAccount", name: "default", namespace: "default" },
    ];
    expect(subjectsSummary(subjects)).toBe("sa:default/default");
  });

  test("formats User/Group without namespace as kind:name", () => {
    const subjects: Subject[] = [
      { kind: "User", name: "alice" },
      { kind: "Group", name: "admin" },
    ];
    expect(subjectsSummary(subjects)).toBe("user:alice, group:admin");
  });

  test("joins first 3 and appends remainder count", () => {
    const subjects: Subject[] = [
      { kind: "User", name: "alice" },
      { kind: "User", name: "bob" },
      { kind: "Group", name: "admin" },
      { kind: "ServiceAccount", name: "webhook", namespace: "kube-system" },
    ];
    expect(subjectsSummary(subjects)).toBe("user:alice, user:bob, group:admin +1");
  });

  test("appends +N for several extras", () => {
    const subjects: Subject[] = Array.from({ length: 5 }, (_, i) => ({
      kind: "User",
      name: `u${i}`,
    }));
    expect(subjectsSummary(subjects)).toBe("user:u0, user:u1, user:u2 +2");
  });

  test("missing kind renders as '?'", () => {
    expect(subjectsSummary([{ name: "x" }])).toBe("?:x");
  });

  test("ServiceAccount without namespace falls back to kind:name", () => {
    expect(subjectsSummary([{ kind: "ServiceAccount", name: "sa1" }])).toBe("sa:sa1");
  });
});

describe("rulesSummary", () => {
  test("returns 'no rules' for undefined/empty", () => {
    expect(rulesSummary(undefined)).toBe("no rules");
    expect(rulesSummary([])).toBe("no rules");
  });

  test("formats [''] apiGroups as core", () => {
    const rules: PolicyRule[] = [
      { apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] },
    ];
    expect(rulesSummary(rules)).toBe("core pods get, list");
  });

  test("formats missing apiGroups as core", () => {
    const rules: PolicyRule[] = [{ resources: ["pods"], verbs: ["get"] }];
    expect(rulesSummary(rules)).toBe("core pods get");
  });

  test("preserves wildcards", () => {
    const rules: PolicyRule[] = [
      { apiGroups: ["*"], resources: ["*"], verbs: ["*"] },
    ];
    expect(rulesSummary(rules)).toBe("* * *");
  });

  test("joins multiple rules with newline + indent", () => {
    const rules: PolicyRule[] = [
      { apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] },
      { apiGroups: ["apps"], resources: ["deployments"], verbs: ["*"] },
    ];
    expect(rulesSummary(rules)).toBe(
      "core pods get, list\n  apps deployments *",
    );
  });
});

describe("matchesSearch", () => {
  test("empty query always matches", () => {
    expect(matchesSearch(["anything"], "")).toBe(true);
    expect(matchesSearch(["anything"], "   ")).toBe(true);
  });

  test("case-insensitive substring match across fields", () => {
    expect(matchesSearch(["pod-reader", "default", "get,list"], "pod")).toBe(true);
    expect(matchesSearch(["pod-reader", "default", "get,list"], "POD")).toBe(true);
  });

  test("returns false when no field contains the query", () => {
    expect(matchesSearch(["admin", "default"], "role")).toBe(false);
  });

  test("ignores undefined/null fields", () => {
    expect(matchesSearch([undefined, "alice", undefined], "alice")).toBe(true);
  });
});

function meta(name: string, namespace?: string): { metadata: ObjectMeta } {
  return { metadata: { name, namespace } };
}

describe("sortByNamespaceName", () => {
  test("sorts by namespace then name; empty namespace first", () => {
    const items = [
      meta("b", "ns2"),
      meta("a", "ns2"),
      meta("z", "ns1"),
      meta("x"),
    ];
    const sorted = sortByNamespaceName(items).map(
      (i) => `${i.metadata.namespace ?? ""}/${i.metadata.name}`,
    );
    expect(sorted).toEqual(["/x", "ns1/z", "ns2/a", "ns2/b"]);
  });

  test("does not mutate input", () => {
    const items = [meta("b", "ns"), meta("a", "ns")];
    const copy = [...items];
    sortByNamespaceName(items);
    expect(items).toEqual(copy);
  });
});

describe("sortByName", () => {
  test("sorts by name lexicographically", () => {
    const items = [meta("charlie"), meta("alpha"), meta("bravo")];
    const sorted = sortByName(items).map((i) => i.metadata.name);
    expect(sorted).toEqual(["alpha", "bravo", "charlie"]);
  });

  test("does not mutate input", () => {
    const items = [meta("b"), meta("a")];
    const copy = [...items];
    sortByName(items);
    expect(items).toEqual(copy);
  });
});
