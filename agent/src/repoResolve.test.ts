import { describe, expect, test, vi } from "vitest";
import { resolveWorkloadRepo, type RepoResolveDeps } from "./repoResolve.js";
import type { KubectlResult } from "./kubectl.js";

const ok = (stdout: string): KubectlResult => ({ stdout, stderr: "", code: 0 });
const fail = (): KubectlResult => ({ stdout: "", stderr: "not found", code: 1 });

function deploymentJSON(annotations: Record<string, string>): string {
  return JSON.stringify({ kind: "Deployment", metadata: { name: "memos", annotations } });
}

function gitSourcesCM(sources: unknown): string {
  return JSON.stringify({ data: { "sources.json": JSON.stringify(sources) } });
}

const SOURCE = [
  {
    name: "memos-repo",
    repoURL: "https://github.com/me/infra",
    branch: "main",
    deployments: [{ name: "memos", path: "apps/memos" }],
  },
];

/** Build a kubectl mock that answers the deployment get, then the git-sources get. */
function mockKubectl(deploymentRes: KubectlResult, sourcesRes?: KubectlResult): RepoResolveDeps {
  const kubectl = vi.fn(async (args: string[]) => {
    if (args[1] === "deployment") return deploymentRes;
    if (args[1] === "configmap") return sourcesRes ?? fail();
    return fail();
  });
  return { kubectl };
}

describe("resolveWorkloadRepo", () => {
  test("annotated + matched → resolves repoURL/branch/path", async () => {
    const deps = mockKubectl(
      ok(deploymentJSON({ "rigel.dev/source-repo": "memos", "rigel.dev/source-path": "apps/memos" })),
      ok(gitSourcesCM(SOURCE)),
    );
    const res = await resolveWorkloadRepo(deps, "default", "memos", "default");
    expect(res).toEqual({
      source: "memos",
      repoURL: "https://github.com/me/infra",
      branch: "main",
      path: "apps/memos",
    });
  });

  test("falls back to the configured deployment path when the source-path annotation is absent", async () => {
    const deps = mockKubectl(
      ok(deploymentJSON({ "rigel.dev/source-repo": "memos" })),
      ok(gitSourcesCM(SOURCE)),
    );
    const res = await resolveWorkloadRepo(deps, "default", "memos", "default");
    expect(res?.path).toBe("apps/memos");
  });

  test("unannotated workload → null (not autofix-eligible)", async () => {
    const deps = mockKubectl(ok(deploymentJSON({ "some.other/annotation": "x" })));
    expect(await resolveWorkloadRepo(deps, "default", "memos", "default")).toBeNull();
  });

  test("annotated but the source is not in the ConfigMap → null", async () => {
    const deps = mockKubectl(
      ok(deploymentJSON({ "rigel.dev/source-repo": "ghost" })),
      ok(gitSourcesCM(SOURCE)),
    );
    expect(await resolveWorkloadRepo(deps, "default", "memos", "default")).toBeNull();
  });

  test("Deployment unreadable (RBAC / absent) → null, and never reads the ConfigMap", async () => {
    const kubectl = vi.fn(async () => fail());
    expect(await resolveWorkloadRepo({ kubectl }, "default", "memos", "default")).toBeNull();
    expect(kubectl).toHaveBeenCalledTimes(1); // bailed before the git-sources read
  });

  test("git-sources ConfigMap unreadable → null", async () => {
    const deps = mockKubectl(ok(deploymentJSON({ "rigel.dev/source-repo": "memos" })), fail());
    expect(await resolveWorkloadRepo(deps, "default", "memos", "default")).toBeNull();
  });
});
