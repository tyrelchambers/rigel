import { describe, expect, test } from "vitest";
import { isInAutofixScope, podProjectId, podInAutofixScope, selectLogScanPods } from "./autofixScope.js";
import type { AutofixConfig, AutofixScope } from "./runtimeConfig.js";

const scope = (projects: string[]): AutofixScope => ({ projects });

function pod(name: string, namespace: string, replicaSet?: string) {
  const ownerReferences = replicaSet ? [{ kind: "ReplicaSet", name: replicaSet }] : [];
  return { metadata: { name, namespace, ownerReferences } };
}

describe("isInAutofixScope", () => {
  test("matches on project id", () => {
    expect(isInAutofixScope(scope(["prod/api"]), "prod/api")).toBe(true);
  });
  test("a project whose namespace would once have matched is NOT in scope unless its project id is listed", () => {
    // The removed namespace-OR branch: listing a sibling project in the same
    // namespace must NOT pull in "prod/api".
    expect(isInAutofixScope(scope(["prod/web"]), "prod/api")).toBe(false);
  });
  test("no match when the project id isn't listed", () => {
    expect(isInAutofixScope(scope(["staging/api", "prod/web"]), "prod/api")).toBe(false);
  });
  test("empty scope matches nothing", () => {
    expect(isInAutofixScope(scope([]), "prod/api")).toBe(false);
  });
});

describe("podProjectId", () => {
  test("derives namespace/deployment by stripping the ReplicaSet hash", () => {
    expect(podProjectId(pod("api-7d8f99-xyz", "prod", "api-7d8f99"))).toBe("prod/api");
  });
  test("handles multi-segment deployment names", () => {
    expect(podProjectId(pod("my-app-v2-abc12-q", "prod", "my-app-v2-abc12"))).toBe("prod/my-app-v2");
  });
  test("null when there is no ReplicaSet owner (bare pod / Job / StatefulSet)", () => {
    expect(podProjectId(pod("solo", "prod"))).toBeNull();
    expect(podProjectId({ metadata: { namespace: "prod", ownerReferences: [{ kind: "StatefulSet", name: "db" }] } })).toBeNull();
  });
});

describe("podInAutofixScope", () => {
  test("project opt-in covers only that deployment's pods", () => {
    const s = scope(["prod/api"]);
    expect(podInAutofixScope(s, pod("api-7d8f99-xyz", "prod", "api-7d8f99"))).toBe(true);
    expect(podInAutofixScope(s, pod("web-aaa-bbb", "prod", "web-aaa"))).toBe(false);
  });
  test("a sibling project in the same namespace does NOT pull in another deployment's pods", () => {
    // The removed namespace-match path: opting in "prod/web" must not scan "prod/api".
    expect(podInAutofixScope(scope(["prod/web"]), pod("api-7d8f99-xyz", "prod", "api-7d8f99"))).toBe(false);
  });
  test("out of scope when the project id isn't listed", () => {
    expect(podInAutofixScope(scope(["staging/api"]), pod("api-1-2", "prod", "api-1"))).toBe(false);
  });
  test("a pod with no derivable project id is never in scope", () => {
    expect(podInAutofixScope(scope(["prod/db"]), pod("db-0", "prod"))).toBe(false);
  });
});

describe("selectLogScanPods", () => {
  const enabled = (s: AutofixScope): AutofixConfig => ({ enabled: true, scope: s, maxPerDay: 5 });
  const pods = [
    pod("api-7d8f99-xyz", "prod", "api-7d8f99"),
    pod("web-aaa-bbb", "prod", "web-aaa"),
    pod("job-1", "staging"),
  ];

  test("disabled → no pods scanned at all (regardless of scope)", () => {
    expect(selectLogScanPods({ enabled: false, scope: scope(["prod/api"]), maxPerDay: 5 }, pods)).toEqual([]);
  });
  test("enabled + project in scope → scans only that project's pods", () => {
    const selected = selectLogScanPods(enabled(scope(["prod/api"])), pods);
    expect(selected).toEqual([pods[0]]);
  });
  test("enabled + multiple projects in scope → scans each opted-in deployment's pods", () => {
    const selected = selectLogScanPods(enabled(scope(["prod/api", "prod/web"])), pods);
    expect(selected).toEqual([pods[0], pods[1]]);
  });
  test("enabled but out-of-scope pods are skipped", () => {
    expect(selectLogScanPods(enabled(scope(["nope/x"])), pods)).toEqual([]);
  });
});
