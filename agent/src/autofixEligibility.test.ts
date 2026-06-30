import { describe, expect, test, vi } from "vitest";
import { incidentDeployment, resolveAutofixEligibility } from "./autofixEligibility.js";
import type { AutofixConfig } from "./runtimeConfig.js";
import type { Incident } from "./detector.js";
import type { ResolvedRepo } from "./repoResolve.js";

const REPO: ResolvedRepo = { source: "memos", repoURL: "https://github.com/me/infra", branch: "main", path: "apps/memos" };

function pod(name: string, namespace: string, replicaSet?: string) {
  const ownerReferences = replicaSet ? [{ kind: "ReplicaSet", name: replicaSet }] : [];
  return { metadata: { name, namespace, ownerReferences } };
}

const podInc = (name: string, namespace = "default"): Incident =>
  ({ incidentKind: "unhealthyPod", name, namespace, reason: "CrashLoopBackOff", detail: "" });
const depInc = (name: string, namespace = "default"): Incident =>
  ({ incidentKind: "degradedDeployment", name, namespace, reason: "Degraded", detail: "" });

const autofix = (enabled: boolean, projects: string[] = []): AutofixConfig =>
  ({ enabled, scope: { projects }, maxPerDay: 5 });

describe("incidentDeployment", () => {
  test("a degradedDeployment incident IS the deployment (name used directly)", () => {
    expect(incidentDeployment(depInc("api"), [])).toBe("api");
  });

  test("a pod incident walks pod→ReplicaSet→Deployment via the owner hash strip", () => {
    const pods = [pod("api-7d8f99-xyz", "default", "api-7d8f99")];
    expect(incidentDeployment(podInc("api-7d8f99-xyz"), pods)).toBe("api");
  });

  test("null when the pod isn't in the snapshot", () => {
    expect(incidentDeployment(podInc("ghost-pod"), [pod("other-1-2", "default", "other-1")])).toBeNull();
  });

  test("null when the pod has no ReplicaSet owner (bare pod / StatefulSet / Job)", () => {
    expect(incidentDeployment(podInc("solo"), [pod("solo", "default")])).toBeNull();
  });

  test("matches the pod on namespace too, not just name", () => {
    const pods = [pod("api-7d8f99-xyz", "prod", "api-7d8f99")];
    expect(incidentDeployment(podInc("api-7d8f99-xyz", "default"), pods)).toBeNull();
    expect(incidentDeployment(podInc("api-7d8f99-xyz", "prod"), pods)).toBe("api");
  });
});

describe("resolveAutofixEligibility", () => {
  test("autofix disabled → not in scope, no repo, never resolves", async () => {
    const resolveRepo = vi.fn(async () => REPO);
    const e = await resolveAutofixEligibility(autofix(false, ["default/api"]), depInc("api"), [], { resolveRepo });
    expect(e).toEqual({ inScope: false, repo: null });
    expect(resolveRepo).not.toHaveBeenCalled();
  });

  test("owning deployment can't be determined → not in scope, never resolves", async () => {
    const resolveRepo = vi.fn(async () => REPO);
    const e = await resolveAutofixEligibility(autofix(true, ["default/api"]), podInc("solo"), [pod("solo", "default")], { resolveRepo });
    expect(e).toEqual({ inScope: false, repo: null });
    expect(resolveRepo).not.toHaveBeenCalled();
  });

  test("out of scope (a sibling project in the same namespace) → not in scope, never resolves", async () => {
    const resolveRepo = vi.fn(async () => REPO);
    // "default/api" is the workload; opting in only "default/web" must NOT cover it.
    const e = await resolveAutofixEligibility(autofix(true, ["default/web"]), depInc("api"), [], { resolveRepo });
    expect(e).toEqual({ inScope: false, repo: null });
    expect(resolveRepo).not.toHaveBeenCalled();
  });

  test("in scope but no GitOps source → in scope, repo null", async () => {
    const resolveRepo = vi.fn(async () => null);
    const e = await resolveAutofixEligibility(autofix(true, ["default/api"]), depInc("api"), [], { resolveRepo });
    expect(e).toEqual({ inScope: true, repo: null });
    expect(resolveRepo).toHaveBeenCalledWith("default", "api");
  });

  test("in scope + GitOps source resolves → eligible (in scope + repo)", async () => {
    const resolveRepo = vi.fn(async () => REPO);
    const e = await resolveAutofixEligibility(autofix(true, ["default/api"]), depInc("api"), [], { resolveRepo });
    expect(e).toEqual({ inScope: true, repo: REPO });
  });

  test("a pod incident: walks to the deployment, scopes by project id, resolves with that name", async () => {
    const resolveRepo = vi.fn(async () => REPO);
    const pods = [pod("api-7d8f99-xyz", "default", "api-7d8f99")];
    const e = await resolveAutofixEligibility(autofix(true, ["default/api"]), podInc("api-7d8f99-xyz"), pods, { resolveRepo });
    expect(e).toEqual({ inScope: true, repo: REPO });
    expect(resolveRepo).toHaveBeenCalledWith("default", "api");
  });
});
