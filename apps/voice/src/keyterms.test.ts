import { describe, expect, test } from "vitest";
import {
  buildKeyterms,
  sameKeyterms,
  INTERRUPTION_KEYTERMS,
  KUBERNETES_KEYTERMS,
  MAX_KEYTERMS,
  MAX_KEYTERM_LENGTH,
  STATIC_KEYTERMS,
} from "./keyterms.js";

describe("STATIC_KEYTERMS", () => {
  test("carries the words an operator cuts the agent off with", () => {
    for (const t of ["cancel", "no", "stop", "wait", "abort", "never mind", "don't"]) {
      expect(INTERRUPTION_KEYTERMS).toContain(t);
    }
  });

  test("does not bias the STT toward a word that can no longer run anything", () => {
    expect(INTERRUPTION_KEYTERMS).not.toContain("confirm");
  });

  test("carries the Kubernetes states and kinds a general model mangles", () => {
    for (const t of ["CrashLoopBackOff", "ImagePullBackOff", "OOMKilled", "StatefulSet", "PodDisruptionBudget"]) {
      expect(KUBERNETES_KEYTERMS).toContain(t);
    }
  });

  test("leaves room for cluster names inside the cap", () => {
    expect(STATIC_KEYTERMS.length).toBeLessThan(MAX_KEYTERMS / 2);
  });

  test("holds no duplicates", () => {
    expect(new Set(STATIC_KEYTERMS.map((t) => t.toLowerCase())).size).toBe(STATIC_KEYTERMS.length);
  });
});

describe("buildKeyterms", () => {
  test("with no cluster names it is exactly the static list", () => {
    expect(buildKeyterms([])).toEqual(STATIC_KEYTERMS);
  });

  test("appends cluster names after the static terms, in the order given", () => {
    const terms = buildKeyterms(["web", "cert-manager-x", "node-1"]);
    expect(terms.slice(STATIC_KEYTERMS.length)).toEqual(["web", "cert-manager-x", "node-1"]);
  });

  test("a cluster name already covered by a static term is not repeated", () => {
    const terms = buildKeyterms(["ingress", "web"]);
    expect(terms.filter((t) => t.toLowerCase() === "ingress")).toHaveLength(1);
    expect(terms).toContain("web");
  });

  test("a name repeated across kinds takes one slot", () => {
    const terms = buildKeyterms(["web", "web", "WEB"]);
    expect(terms.filter((t) => t.toLowerCase() === "web")).toHaveLength(1);
  });

  test("blank names are dropped", () => {
    expect(buildKeyterms(["", "   "])).toEqual(STATIC_KEYTERMS);
  });

  test("names longer than the length bound are dropped", () => {
    const long = "a".repeat(MAX_KEYTERM_LENGTH + 1);
    expect(buildKeyterms([long, "web"])).toContain("web");
    expect(buildKeyterms([long])).toEqual(STATIC_KEYTERMS);
  });

  test("the total never exceeds the cap, and the earliest names win", () => {
    const names = Array.from({ length: 200 }, (_, i) => `svc-${i}`);
    const terms = buildKeyterms(names);
    expect(terms).toHaveLength(MAX_KEYTERMS);
    expect(terms.slice(0, STATIC_KEYTERMS.length)).toEqual(STATIC_KEYTERMS);
    expect(terms).toContain("svc-0");
    expect(terms).not.toContain(`svc-${MAX_KEYTERMS}`);
  });
});

describe("sameKeyterms", () => {
  test("equal lists in equal order match", () => {
    expect(sameKeyterms(["a", "b"], ["a", "b"])).toBe(true);
  });

  test("reordering is a change", () => {
    expect(sameKeyterms(["a", "b"], ["b", "a"])).toBe(false);
  });

  test("a different length is a change", () => {
    expect(sameKeyterms(["a"], ["a", "b"])).toBe(false);
  });
});
