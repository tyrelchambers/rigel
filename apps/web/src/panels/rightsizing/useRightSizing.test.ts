import { describe, expect, it } from "vitest";
import { resolveNamespaceScope } from "./useRightSizing";

describe("resolveNamespaceScope", () => {
  it("is cluster-wide ('*') when clusterWide is set, ignoring the namespace filter", () => {
    expect(resolveNamespaceScope("kube-system", true)).toBe("*");
    expect(resolveNamespaceScope(null, true)).toBe("*");
  });

  it("uses the selected namespace when not cluster-wide", () => {
    expect(resolveNamespaceScope("kube-system", false)).toBe("kube-system");
  });

  it("falls back to '*' when no namespace is selected and not cluster-wide", () => {
    expect(resolveNamespaceScope(null, false)).toBe("*");
  });
});
