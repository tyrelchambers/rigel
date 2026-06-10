import { describe, expect, test } from "vitest";
import type { Namespace } from "./types";
import type { Pod } from "../pods/types";
import {
  relativeAge,
  phaseOf,
  namespacePhaseColorClass,
  podCountInNamespace,
  podCountLabel,
  matchesSearch,
  sortNamespaces,
  isValidNamespaceName,
} from "./namespaceDisplay";

function ns(overrides: Partial<Namespace> = {}): Namespace {
  return {
    metadata: { name: "default", uid: "u1", ...overrides.metadata },
    status: overrides.status,
  };
}

function pod(name: string, namespace: string): Pod {
  return {
    metadata: { name, namespace, uid: `${namespace}/${name}` },
    spec: { containers: [{ name }] },
  };
}

describe("relativeAge", () => {
  const now = Date.parse("2026-06-09T12:00:00Z");
  test("seconds / minutes / hours / days and dash fallback", () => {
    expect(relativeAge("2026-06-09T11:59:55Z", now)).toBe("5s");
    expect(relativeAge("2026-06-09T11:57:00Z", now)).toBe("3m");
    expect(relativeAge("2026-06-09T10:00:00Z", now)).toBe("2h");
    expect(relativeAge("2026-06-08T12:00:00Z", now)).toBe("1d");
    expect(relativeAge(undefined, now)).toBe("—");
  });
});

describe("phaseOf", () => {
  test("defaults to Active when status/phase missing", () => {
    expect(phaseOf(ns())).toBe("Active");
    expect(phaseOf(ns({ status: {} }))).toBe("Active");
    expect(phaseOf(ns({ status: { phase: "Terminating" } }))).toBe("Terminating");
  });
});

describe("namespacePhaseColorClass", () => {
  test("Active=green, Terminating=yellow, other=muted", () => {
    expect(namespacePhaseColorClass("Active")).toContain("green");
    expect(namespacePhaseColorClass("Terminating")).toContain("yellow");
    expect(namespacePhaseColorClass("Weird")).toContain("muted");
  });
});

describe("podCountInNamespace / podCountLabel", () => {
  const pods = [
    pod("a", "default"),
    pod("b", "default"),
    pod("c", "kube-system"),
  ];
  test("counts pods whose namespace matches", () => {
    expect(podCountInNamespace(ns({ metadata: { name: "default", uid: "1" } }), pods)).toBe(2);
    expect(podCountInNamespace(ns({ metadata: { name: "kube-system", uid: "2" } }), pods)).toBe(1);
    expect(podCountInNamespace(ns({ metadata: { name: "empty", uid: "3" } }), pods)).toBe(0);
  });
  test("null pods (watch not subscribed) yields null → dash label", () => {
    expect(podCountInNamespace(ns(), null)).toBeNull();
    expect(podCountLabel(null)).toBe("—");
  });
  test("label singular/plural/zero", () => {
    expect(podCountLabel(0)).toBe("0 pods");
    expect(podCountLabel(1)).toBe("1 pod");
    expect(podCountLabel(2)).toBe("2 pods");
  });
});

describe("matchesSearch", () => {
  const kube = ns({ metadata: { name: "kube-system", uid: "1" }, status: { phase: "Active" } });
  const term = ns({ metadata: { name: "old-ns", uid: "2" }, status: { phase: "Terminating" } });
  test("empty query matches everything", () => {
    expect(matchesSearch(kube, "")).toBe(true);
    expect(matchesSearch(kube, "   ")).toBe(true);
  });
  test("case-insensitive substring on name and phase", () => {
    expect(matchesSearch(kube, "KUBE")).toBe(true); // name
    expect(matchesSearch(kube, "active")).toBe(true); // phase (defaulted)
    expect(matchesSearch(term, "terminating")).toBe(true); // phase
  });
  test("no match returns false", () => {
    expect(matchesSearch(kube, "nginx")).toBe(false);
  });
  test("phase defaults to Active so 'active' matches a namespace with no status", () => {
    expect(matchesSearch(ns(), "active")).toBe(true);
  });
});

describe("sortNamespaces", () => {
  test("lexicographic case-sensitive ascending by name", () => {
    const a = ns({ metadata: { name: "zeta", uid: "1" } });
    const b = ns({ metadata: { name: "alpha", uid: "2" } });
    const c = ns({ metadata: { name: "Beta", uid: "3" } });
    const sorted = sortNamespaces([a, b, c]).map((n) => n.metadata.name);
    // Uppercase sorts before lowercase (case-sensitive ascending).
    expect(sorted).toEqual(["Beta", "alpha", "zeta"]);
  });
});

describe("isValidNamespaceName (DNS-1123)", () => {
  test("valid names", () => {
    expect(isValidNamespaceName("default")).toBe(true);
    expect(isValidNamespaceName("kube-system")).toBe(true);
    expect(isValidNamespaceName("a")).toBe(true);
    expect(isValidNamespaceName("a1")).toBe(true);
    expect(isValidNamespaceName("1ns")).toBe(true);
    expect(isValidNamespaceName("a".repeat(63))).toBe(true);
  });
  test("invalid names", () => {
    expect(isValidNamespaceName("")).toBe(false);
    expect(isValidNamespaceName("a".repeat(64))).toBe(false); // too long
    expect(isValidNamespaceName("-leading")).toBe(false);
    expect(isValidNamespaceName("trailing-")).toBe(false);
    expect(isValidNamespaceName("Upper")).toBe(false); // uppercase
    expect(isValidNamespaceName("under_score")).toBe(false);
    expect(isValidNamespaceName("has space")).toBe(false);
    expect(isValidNamespaceName("dot.name")).toBe(false);
  });
});
