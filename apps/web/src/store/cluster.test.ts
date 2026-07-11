import { describe, it, expect, beforeEach, test } from "vitest";
import { filterByNamespace, readActiveContext, useCluster } from "./cluster";

// Build a minimal k8s-ish object with a resourceVersion. Each call returns a
// fresh reference so tests can assert reference reuse vs. replacement.
function obj(name: string, resourceVersion?: string): Record<string, unknown> {
  return { metadata: { name, ...(resourceVersion != null ? { resourceVersion } : {}) } };
}

const KIND = "Pod";

// Reset the store between multi-cluster tests (zustand stores are module singletons).
beforeEach(() => {
  useCluster.setState({
    resources: {},
    activeContext: null,
    namespaceByContext: {},
    namespaceFilter: null,
  });
});

test("applySwitch sets activeContext, adopts the namespace, and clears resources", () => {
  useCluster.setState({ resources: { pods: { "default/a": {} } } });
  useCluster.getState().applySwitch("prod", "kube-system");
  const s = useCluster.getState();
  expect(s.activeContext).toBe("prod");
  expect(s.namespaceFilter).toBe("kube-system");
  expect(s.resources).toEqual({}); // stale cluster data dropped
});

test("setNamespaceFilter records the namespace under the active context", () => {
  useCluster.getState().setActiveContextInitial("prod");
  useCluster.getState().setNamespaceFilter("team-a");
  expect(useCluster.getState().namespaceByContext["prod"]).toBe("team-a");
});

test("switching back to a context restores its remembered namespace; an unseen context defaults to all (null)", () => {
  useCluster.getState().setActiveContextInitial("prod");
  useCluster.getState().setNamespaceFilter("team-a");
  useCluster.getState().applySwitch("dev", useCluster.getState().namespaceByContext["dev"] ?? null);
  expect(useCluster.getState().namespaceFilter).toBe(null);
  useCluster.getState().applySwitch("prod", useCluster.getState().namespaceByContext["prod"] ?? null);
  expect(useCluster.getState().namespaceFilter).toBe("team-a");
});

test("setActiveContextInitial does NOT clear resources", () => {
  useCluster.setState({ resources: { pods: { "default/a": {} } } });
  useCluster.getState().setActiveContextInitial("prod");
  expect(useCluster.getState().resources).toEqual({ pods: { "default/a": {} } });
});

describe("replaceKind — identity reconciliation", () => {
  beforeEach(() => {
    // Reset to a known empty baseline so the singleton store doesn't leak
    // state between tests.
    useCluster.getState().clearKind(KIND);
  });

  it("an identical snapshot leaves state identity unchanged (no re-render)", () => {
    const a = obj("a", "1");
    const b = obj("b", "2");
    useCluster.getState().replaceKind(KIND, { a, b });

    const resourcesBefore = useCluster.getState().resources;
    const sliceBefore = resourcesBefore[KIND];
    const aBefore = sliceBefore.a;
    const bBefore = sliceBefore.b;

    // Same keys, same resourceVersions, but BRAND-NEW incoming object refs.
    useCluster.getState().replaceKind(KIND, { a: obj("a", "1"), b: obj("b", "2") });

    const resourcesAfter = useCluster.getState().resources;
    // Whole resources object identity is preserved (set returned {}).
    expect(resourcesAfter).toBe(resourcesBefore);
    // The kind slice identity is preserved.
    expect(resourcesAfter[KIND]).toBe(sliceBefore);
    // Per-item references are preserved.
    expect(resourcesAfter[KIND].a).toBe(aBefore);
    expect(resourcesAfter[KIND].b).toBe(bBefore);
  });

  it("a changed resourceVersion replaces only that item's reference", () => {
    const a = obj("a", "1");
    const b = obj("b", "2");
    useCluster.getState().replaceKind(KIND, { a, b });

    const resourcesBefore = useCluster.getState().resources;
    const aBefore = resourcesBefore[KIND].a;
    const bBefore = resourcesBefore[KIND].b;

    // b's resourceVersion bumped; a unchanged.
    const newB = obj("b", "3");
    useCluster.getState().replaceKind(KIND, { a: obj("a", "1"), b: newB });

    const resourcesAfter = useCluster.getState().resources;
    // resources slice is a new object because something changed.
    expect(resourcesAfter).not.toBe(resourcesBefore);
    expect(resourcesAfter[KIND]).not.toBe(resourcesBefore[KIND]);
    // a kept its original reference; b is the new reference.
    expect(resourcesAfter[KIND].a).toBe(aBefore);
    expect(resourcesAfter[KIND].b).not.toBe(bBefore);
    expect(resourcesAfter[KIND].b).toBe(newB);
  });

  it("adding a new key surfaces it and preserves surviving refs", () => {
    const a = obj("a", "1");
    useCluster.getState().replaceKind(KIND, { a });

    const resourcesBefore = useCluster.getState().resources;
    const aBefore = resourcesBefore[KIND].a;

    const newC = obj("c", "9");
    useCluster.getState().replaceKind(KIND, { a: obj("a", "1"), c: newC });

    const resourcesAfter = useCluster.getState().resources;
    expect(resourcesAfter).not.toBe(resourcesBefore);
    expect(Object.keys(resourcesAfter[KIND]).sort()).toEqual(["a", "c"]);
    // a survived unchanged → original ref preserved.
    expect(resourcesAfter[KIND].a).toBe(aBefore);
    expect(resourcesAfter[KIND].c).toBe(newC);
  });

  it("removing a key drops it and preserves surviving refs", () => {
    const a = obj("a", "1");
    const b = obj("b", "2");
    useCluster.getState().replaceKind(KIND, { a, b });

    const resourcesBefore = useCluster.getState().resources;
    const aBefore = resourcesBefore[KIND].a;

    // Snapshot now only has a.
    useCluster.getState().replaceKind(KIND, { a: obj("a", "1") });

    const resourcesAfter = useCluster.getState().resources;
    expect(resourcesAfter).not.toBe(resourcesBefore);
    expect(Object.keys(resourcesAfter[KIND])).toEqual(["a"]);
    expect(resourcesAfter[KIND].a).toBe(aBefore);
    expect(resourcesAfter[KIND].b).toBeUndefined();
  });

  it("a missing resourceVersion is treated as changed (new ref), no throw", () => {
    const a = obj("a"); // no resourceVersion
    useCluster.getState().replaceKind(KIND, { a });

    const resourcesBefore = useCluster.getState().resources;
    const aBefore = resourcesBefore[KIND].a;

    const newA = obj("a"); // still no resourceVersion
    expect(() => useCluster.getState().replaceKind(KIND, { a: newA })).not.toThrow();

    const resourcesAfter = useCluster.getState().resources;
    // Missing rV on both sides → treated as changed → new ref + new slice.
    expect(resourcesAfter).not.toBe(resourcesBefore);
    expect(resourcesAfter[KIND].a).not.toBe(aBefore);
    expect(resourcesAfter[KIND].a).toBe(newA);
  });

  it("does not throw when an incoming item is not an object", () => {
    expect(() =>
      useCluster.getState().replaceKind(KIND, { a: null, b: 42, c: "x" }),
    ).not.toThrow();
    const after = useCluster.getState().resources[KIND];
    expect(after.a).toBe(null);
    expect(after.b).toBe(42);
    expect(after.c).toBe("x");
  });
});

describe("replaceKind — full replace (every watch is cluster-wide)", () => {
  const K = "deployments";
  function nsObj(namespace: string, name: string, rv?: string): Record<string, unknown> {
    return { metadata: { name, namespace, ...(rv != null ? { resourceVersion: rv } : {}) } };
  }
  beforeEach(() => useCluster.getState().clearKind(K));

  it("a snapshot swaps the whole slice (namespace switch replaces, never merges)", () => {
    useCluster.getState().replaceKind(K, { "default/web": nsObj("default", "web", "1") });
    useCluster.getState().replaceKind(K, { "kube-system/dns": nsObj("kube-system", "dns", "1") });
    const slice = useCluster.getState().resources[K];
    expect(slice["default/web"]).toBeUndefined();
    expect(slice["kube-system/dns"]).toBeDefined();
  });

  it("drops items absent from the new snapshot", () => {
    useCluster.getState().replaceKind(K, {
      "default/web": nsObj("default", "web", "1"),
      "default/api": nsObj("default", "api", "1"),
    });
    useCluster.getState().replaceKind(K, { "default/web": nsObj("default", "web", "1") });
    const slice = useCluster.getState().resources[K];
    expect(slice["default/api"]).toBeUndefined();
    expect(slice["default/web"]).toBeDefined();
  });
});

describe("replaceKind — namespace-scoped merge", () => {
  const K = "pods";
  const mkPod = (ns: string, name: string, rv: string) => ({
    metadata: { namespace: ns, name, resourceVersion: rv },
  });
  beforeEach(() => useCluster.getState().clearKind(K));

  it("a scoped replace only touches its namespace's keys", () => {
    const store = useCluster.getState();
    store.replaceKind(K, { "team-a/api": mkPod("team-a", "api", "1") }, "team-a");
    store.replaceKind(K, { "team-b/web": mkPod("team-b", "web", "1") }, "team-b");
    expect(Object.keys(useCluster.getState().resources[K]).sort()).toEqual([
      "team-a/api",
      "team-b/web",
    ]);
    // Re-listing team-a with a removal must not touch team-b.
    store.replaceKind(K, {}, "team-a");
    expect(Object.keys(useCluster.getState().resources[K])).toEqual(["team-b/web"]);
  });

  it("a wildcard replace still full-replaces the kind", () => {
    const store = useCluster.getState();
    store.replaceKind(K, { "team-a/api": mkPod("team-a", "api", "1") }, "*");
    store.replaceKind(K, { "team-b/web": mkPod("team-b", "web", "1") }, "*");
    expect(Object.keys(useCluster.getState().resources[K])).toEqual(["team-b/web"]);
  });
});

describe("setContextAccess", () => {
  beforeEach(() => {
    useCluster.setState({
      activeContext: null,
      accessByContext: {},
      accessMode: "cluster-wide",
      accessNamespaces: [],
    });
  });

  it("surfaces the active context's access into accessMode/accessNamespaces", () => {
    useCluster.getState().setActiveContextInitial("ctx-a");
    useCluster.getState().setContextAccess("ctx-a", "scoped", ["team-a"]);
    const s = useCluster.getState();
    expect(s.accessMode).toBe("scoped");
    expect(s.accessNamespaces).toEqual(["team-a"]);
    expect(s.accessByContext["ctx-a"]).toEqual({ mode: "scoped", namespaces: ["team-a"] });
  });

  it("records a non-active context's access without touching the active context's surfaced values", () => {
    useCluster.getState().setActiveContextInitial("ctx-a");
    useCluster.getState().setContextAccess("ctx-a", "scoped", ["team-a"]);
    useCluster.getState().setContextAccess("ctx-b", "scoped", ["team-b"]);
    const s = useCluster.getState();
    expect(s.accessMode).toBe("scoped");
    expect(s.accessNamespaces).toEqual(["team-a"]);
    expect(s.accessByContext["ctx-b"]).toEqual({ mode: "scoped", namespaces: ["team-b"] });
  });

  it("applySwitch surfaces the target context's stored access", () => {
    useCluster.getState().setActiveContextInitial("ctx-a");
    useCluster.getState().setContextAccess("ctx-a", "scoped", ["team-a"]);
    useCluster.getState().setContextAccess("ctx-b", "scoped", ["team-b"]);
    useCluster.getState().applySwitch("ctx-b", null);
    const s = useCluster.getState();
    expect(s.accessMode).toBe("scoped");
    expect(s.accessNamespaces).toEqual(["team-b"]);
  });

  it("applySwitch to an unknown context resets to cluster-wide", () => {
    useCluster.getState().setActiveContextInitial("ctx-a");
    useCluster.getState().setContextAccess("ctx-a", "scoped", ["team-a"]);
    useCluster.getState().applySwitch("ctx-unknown", null);
    const s = useCluster.getState();
    expect(s.accessMode).toBe("cluster-wide");
    expect(s.accessNamespaces).toEqual([]);
  });
});

it("records per-kind access without touching the global error", () => {
  useCluster.setState({ error: null });
  useCluster.getState().setAccess("secrets", { status: "forbidden", message: "denied" });
  expect(useCluster.getState().accessByKind["secrets"].status).toBe("forbidden");
  expect(useCluster.getState().error).toBeNull();
});

describe("filterByNamespace", () => {
  function nsObj(namespace: string, name: string): { metadata: { namespace?: string; name: string } } {
    return { metadata: { name, namespace } };
  }
  function clusterObj(name: string): { metadata: { namespace?: string; name: string } } {
    return { metadata: { name } };
  }

  it("null filter returns all items (All namespaces)", () => {
    const slice = { "default/a": nsObj("default", "a"), "kube-system/b": nsObj("kube-system", "b") };
    expect(filterByNamespace(slice, null)).toHaveLength(2);
  });

  it("a specific namespace returns only its items", () => {
    const slice = {
      "default/a": nsObj("default", "a"),
      "default/b": nsObj("default", "b"),
      "kube-system/c": nsObj("kube-system", "c"),
    };
    const got = filterByNamespace(slice, "default");
    expect(got.map((o) => o.metadata.name).sort()).toEqual(["a", "b"]);
  });

  it("cluster-scoped items (no namespace) always pass under a specific filter", () => {
    const slice = {
      "pv-1": clusterObj("pv-1"),
      "default/a": nsObj("default", "a"),
      "kube-system/b": nsObj("kube-system", "b"),
    };
    const got = filterByNamespace(slice, "default");
    expect(got.map((o) => o.metadata.name).sort()).toEqual(["a", "pv-1"]);
  });

  it("an empty or undefined slice returns []", () => {
    expect(filterByNamespace(undefined, "default")).toEqual([]);
    expect(filterByNamespace({}, null)).toEqual([]);
  });
});

describe("active context persistence", () => {
  beforeEach(() => localStorage.removeItem("rigel_active_context"));

  it("persists the active context on switch and reads it back", () => {
    useCluster.getState().applySwitch("ctx-b", null);
    expect(readActiveContext()).toBe("ctx-b");
  });

  it("has no persisted context before any switch", () => {
    expect(readActiveContext()).toBeNull();
  });
});
