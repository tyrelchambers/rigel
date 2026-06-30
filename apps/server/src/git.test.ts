import { test, expect, describe, beforeEach, vi } from "vitest";

// linkRepo's cluster I/O is exercised via mocked module deps (kubectl +
// applyManifest); the pure planRepoLink / provenanceId tests below don't touch
// them. Hoisted so the vi.mock factories can reference the spies.
const { kubectlMock, applyManifestMock } = vi.hoisted(() => ({
  kubectlMock: vi.fn(),
  applyManifestMock: vi.fn(),
}));
vi.mock("@rigel/k8s/src/run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rigel/k8s/src/run")>();
  return { ...actual, kubectl: kubectlMock };
});
vi.mock("./install", () => ({ applyManifest: applyManifestMock }));

import { planRepoLink, provenanceId, linkRepo, ClusterWriteError } from "./git";
import { SOURCE_REPO_ANNOTATION, SOURCE_PATH_ANNOTATION, type GitSource } from "@rigel/k8s/src/gitSources";

// planRepoLink is the pure core of the "Link to repo" flow: derive the source
// slug + provenance id, create-or-extend the rigel-git-sources entry, and compute
// the annotation pairs to stamp. Asserted without a cluster. The provenance id
// (provenanceId) is collision-resistant: <slug>-<7 hex of sha256("<ns>/<dep>")>.

const ID_DEFAULT_WEB = provenanceId("default", "web"); // "default-web-82b3ade"

describe("planRepoLink", () => {
  test("creates a new source + deployment and the provenance annotate for a fresh link", () => {
    const plan = planRepoLink([], {
      namespace: "default",
      deployment: "web",
      repoURL: "https://github.com/me/my-app.git",
      branch: "main",
      path: "k8s/prod",
    });
    expect(plan.result).toEqual({
      ok: true,
      source: ID_DEFAULT_WEB, // == rigel.dev/source-repo value + GitDeployment name
      repo: "me/my-app",
      repoName: "me-my-app",
      repoURL: "https://github.com/me/my-app.git",
      branch: "main",
      path: "k8s/prod",
    });
    expect(plan.sources).toEqual([
      {
        name: "me-my-app",
        repoURL: "https://github.com/me/my-app.git",
        branch: "main",
        deployments: [{ name: ID_DEFAULT_WEB, path: "k8s/prod" }],
      },
    ]);
    // The annotate stamps the workload in ITS namespace; the stamped source-repo
    // value EQUALS the GitDeployment name (so the agent resolves it back).
    expect(plan.annotate).toEqual({
      namespace: "default",
      deployment: "web",
      args: [`${SOURCE_REPO_ANNOTATION}=${ID_DEFAULT_WEB}`, `${SOURCE_PATH_ANNOTATION}=k8s/prod`],
    });
  });

  test("extends an existing repo source with another deployment (preserving the rest)", () => {
    const existing: GitSource[] = [
      {
        name: "me-my-app",
        repoURL: "https://github.com/me/my-app",
        branch: "develop",
        deployments: [{ name: "default-api-legacy", path: "k8s/api", lastSyncedSha: "abc" }],
      },
    ];
    const plan = planRepoLink(existing, {
      namespace: "default",
      deployment: "web",
      repoURL: "https://github.com/me/my-app",
      path: "k8s/web",
    });
    expect(plan.result.branch).toBe("develop"); // inherits the existing repo branch
    const repo = plan.sources.find((s) => s.name === "me-my-app")!;
    expect(repo.deployments).toEqual([
      { name: "default-api-legacy", path: "k8s/api", lastSyncedSha: "abc" }, // untouched
      { name: ID_DEFAULT_WEB, path: "k8s/web" },
    ]);
  });

  test("re-linking the same deployment updates its path (upsert, no duplicate)", () => {
    const existing: GitSource[] = [
      {
        name: "me-my-app",
        repoURL: "https://github.com/me/my-app",
        branch: "main",
        deployments: [{ name: ID_DEFAULT_WEB, path: "k8s/old", lastSyncedSha: "keep" }],
      },
    ];
    const plan = planRepoLink(existing, {
      namespace: "default",
      deployment: "web",
      repoURL: "https://github.com/me/my-app",
      path: "k8s/new",
    });
    const repo = plan.sources.find((s) => s.name === "me-my-app")!;
    expect(repo.deployments).toEqual([{ name: ID_DEFAULT_WEB, path: "k8s/new", lastSyncedSha: "keep" }]);
  });

  test("defaults path to '.' (repo root) and branch to main", () => {
    const id = provenanceId("ns", "app");
    const plan = planRepoLink([], { namespace: "ns", deployment: "app", repoURL: "https://github.com/me/r" });
    expect(plan.result.path).toBe(".");
    expect(plan.result.branch).toBe("main");
    expect(plan.annotate.args).toEqual([`${SOURCE_REPO_ANNOTATION}=${id}`, `${SOURCE_PATH_ANNOTATION}=.`]);
  });

  test("rejects a deployment id already linked to a DIFFERENT repo", () => {
    const existing: GitSource[] = [
      {
        name: "me-other",
        repoURL: "https://github.com/me/other",
        branch: "main",
        deployments: [{ name: ID_DEFAULT_WEB, path: "." }],
      },
    ];
    expect(() =>
      planRepoLink(existing, { namespace: "default", deployment: "web", repoURL: "https://github.com/me/my-app" }),
    ).toThrow(/already linked to repo "me-other"/);
  });

  // M1: two repo URLs can sanitize to the same slug; reusing it for a different
  // URL would silently repoint the existing source's other deployments. Refuse.
  test("rejects a source-slug clash when the existing source has a different repo URL", () => {
    const existing: GitSource[] = [
      {
        // "me/my_app" sanitizes to the same slug as "me/my-app"
        name: "me-my-app",
        repoURL: "https://github.com/me/my_app",
        branch: "main",
        deployments: [{ name: "other-dep", path: "." }],
      },
    ];
    expect(() =>
      planRepoLink(existing, { namespace: "default", deployment: "web", repoURL: "https://github.com/me/my-app" }),
    ).toThrow(/already used by https:\/\/github\.com\/me\/my_app/);
  });

  test("allows reusing a source slug when the repo URL matches modulo trailing .git", () => {
    const existing: GitSource[] = [
      {
        name: "me-my-app",
        repoURL: "https://github.com/me/my-app",
        branch: "main",
        deployments: [{ name: "other-dep", path: "k8s/other" }],
      },
    ];
    // Same repo, with a trailing .git — must extend, not reject.
    const plan = planRepoLink(existing, {
      namespace: "default",
      deployment: "web",
      repoURL: "https://github.com/me/my-app.git",
    });
    const repo = plan.sources.find((s) => s.name === "me-my-app")!;
    expect(repo.deployments.map((d) => d.name)).toEqual(["other-dep", ID_DEFAULT_WEB]);
  });

  test("rejects a missing repoURL / namespace / deployment", () => {
    expect(() => planRepoLink([], { namespace: "n", deployment: "d", repoURL: "" })).toThrow(/repoURL is required/);
    expect(() => planRepoLink([], { namespace: "", deployment: "d", repoURL: "https://github.com/me/r" })).toThrow(
      /namespace and deployment/,
    );
  });

  test("rejects a repoURL with no parseable owner/repo", () => {
    expect(() => planRepoLink([], { namespace: "n", deployment: "d", repoURL: "not a url" })).toThrow(/owner\/repo/);
  });

  test("rejects a path that traverses out of the checkout", () => {
    expect(() =>
      planRepoLink([], { namespace: "n", deployment: "d", repoURL: "https://github.com/me/r", path: "../escape" }),
    ).toThrow(/\.\./);
  });
});

// I1: the provenance id must be collision-resistant on dash-ambiguous names.
describe("provenanceId", () => {
  test("disambiguates dash-colliding (ns, deployment) pairs", () => {
    const a = provenanceId("prod", "web-api"); // "prod-web-api-f6d4be8"
    const b = provenanceId("prod-web", "api"); // "prod-web-api-268657e"
    // Same human-readable prefix (the bug), but DIFFERENT ids (the fix).
    expect(a.startsWith("prod-web-api-")).toBe(true);
    expect(b.startsWith("prod-web-api-")).toBe(true);
    expect(a).not.toBe(b);
  });

  test("is deterministic and uses the EXACT 'ns/deployment' string for the hash", () => {
    expect(provenanceId("default", "web")).toBe("default-web-82b3ade");
    expect(provenanceId("default", "web")).toBe(provenanceId("default", "web"));
  });

  test("is DNS-1123 (lowercase [a-z0-9-]) and stays within 63 chars even for long names", () => {
    const id = provenanceId("a".repeat(80), "b".repeat(80));
    expect(id.length).toBeLessThanOrEqual(63);
    expect(id).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/); // valid object name, no trailing dash
    expect(id).toMatch(/-[0-9a-f]{7}$/); // hash is preserved when truncating
  });

  test("falls back to the bare hash when the slug part sanitizes to empty", () => {
    expect(provenanceId("...", "///")).toMatch(/^[0-9a-f]{7}$/);
  });
});

// M2: cluster WRITE failures must be distinguishable (ClusterWriteError → 5xx)
// from validation/collision errors (plain Error → 422).
describe("linkRepo error classification", () => {
  beforeEach(() => {
    kubectlMock.mockReset();
    applyManifestMock.mockReset();
  });

  const input = { namespace: "default", deployment: "web", repoURL: "https://github.com/me/my-app", path: "k8s" };

  test("returns the link result + stamps the workload on the happy path", async () => {
    kubectlMock
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "NotFound" }) // loadSources get → []
      .mockResolvedValueOnce({ code: 0, stdout: "annotated", stderr: "" }); // annotate ok
    applyManifestMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" }); // saveSources ok

    const result = await linkRepo(null, input);
    expect(result.repo).toBe("me/my-app");
    expect(result.source).toBe(ID_DEFAULT_WEB);
    const annotateArgs = kubectlMock.mock.calls[1]![1] as string[];
    expect(annotateArgs).toEqual(
      expect.arrayContaining(["annotate", "deployment", "web", "--overwrite", `${SOURCE_REPO_ANNOTATION}=${ID_DEFAULT_WEB}`]),
    );
  });

  test("throws ClusterWriteError (→ 5xx) when persisting the source fails", async () => {
    kubectlMock.mockResolvedValue({ code: 1, stdout: "", stderr: "NotFound" }); // loadSources → []
    applyManifestMock.mockResolvedValue({ code: 1, stdout: "", stderr: "forbidden" }); // save fails
    await expect(linkRepo(null, input)).rejects.toBeInstanceOf(ClusterWriteError);
  });

  test("throws ClusterWriteError (→ 5xx) when stamping the Deployment fails", async () => {
    kubectlMock
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "NotFound" }) // loadSources → []
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "forbidden" }); // annotate fails
    applyManifestMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" }); // save ok
    await expect(linkRepo(null, input)).rejects.toBeInstanceOf(ClusterWriteError);
  });

  test("surfaces a validation error as a plain Error (→ 422), never reaching the cluster write", async () => {
    kubectlMock.mockResolvedValue({ code: 1, stdout: "", stderr: "NotFound" }); // loadSources → []
    const err = await linkRepo(null, { namespace: "n", deployment: "d", repoURL: "not a url" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ClusterWriteError);
    expect(applyManifestMock).not.toHaveBeenCalled();
  });
});
