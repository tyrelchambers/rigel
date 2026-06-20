import { test, expect } from "vitest";
import {
  sanitizeSourceName,
  normalizeManifestPath,
  parseRepoSlug,
  buildAuthedCloneURL,
  redactURL,
  parseGitSources,
  gitSourcesConfigMapJSON,
  provenanceAnnotations,
  resolveTarget,
  findByDeployment,
  upsertDeployment,
  SOURCE_REPO_ANNOTATION,
  SOURCE_PATH_ANNOTATION,
  fixBranchName,
  safeRepoFilePath,
  parseGithubRepos,
  githubSecretJSON,
  parseRepoContents,
  GITHUB_SECRET,
  type GitSource,
} from "./gitSources";

test("sanitizeSourceName: lowercases and strips to a DNS-safe slug", () => {
  expect(sanitizeSourceName("My App!")).toBe("my-app");
  expect(sanitizeSourceName("  leading/trailing  ")).toBe("leading-trailing");
  expect(sanitizeSourceName("already-ok")).toBe("already-ok");
});

test("normalizeManifestPath: defaults to '.' and rejects traversal", () => {
  expect(normalizeManifestPath("")).toBe(".");
  expect(normalizeManifestPath("/")).toBe(".");
  expect(normalizeManifestPath("k8s/")).toBe("k8s");
  expect(normalizeManifestPath("/deploy/prod/")).toBe("deploy/prod");
  expect(() => normalizeManifestPath("../etc")).toThrow();
  expect(() => normalizeManifestPath("a/../../b")).toThrow();
});

test("parseRepoSlug: extracts owner/repo from GitHub URLs", () => {
  expect(parseRepoSlug("https://github.com/me/my-app")).toEqual({ owner: "me", repo: "my-app" });
  expect(parseRepoSlug("https://github.com/me/my-app.git")).toEqual({ owner: "me", repo: "my-app" });
  expect(parseRepoSlug("git@github.com:me/my-app.git")).toEqual({ owner: "me", repo: "my-app" });
  expect(parseRepoSlug("not a url")).toBeNull();
});

test("buildAuthedCloneURL: injects x-access-token for https, passes through when no token", () => {
  expect(buildAuthedCloneURL("https://github.com/me/app.git", "ghp_abc")).toBe(
    "https://x-access-token:ghp_abc@github.com/me/app.git",
  );
  expect(buildAuthedCloneURL("https://github.com/me/app", null)).toBe("https://github.com/me/app");
  expect(buildAuthedCloneURL("https://github.com/me/app", "")).toBe("https://github.com/me/app");
});

test("redactURL: masks embedded credentials", () => {
  expect(redactURL("https://x-access-token:ghp_secret@github.com/me/app.git")).toBe(
    "https://x-access-token:***@github.com/me/app.git",
  );
  expect(redactURL("https://github.com/me/app.git")).toBe("https://github.com/me/app.git");
});

test("parseGitSources / gitSourcesConfigMapJSON: round-trips repo→deployments, never carries tokens", () => {
  const sources: GitSource[] = [
    {
      name: "monorepo",
      repoURL: "https://github.com/me/monorepo",
      branch: "main",
      deployments: [
        { name: "marketing", path: "apps/marketing/k8s" },
        { name: "server", path: "apps/server/k8s", lastSyncedSha: "abc123", lastStatus: "ok" },
      ],
    },
    {
      name: "app-two",
      repoURL: "https://github.com/me/app-two",
      branch: "prod",
      deployments: [{ name: "app-two", path: "." }],
    },
  ];
  const cmJSON = gitSourcesConfigMapJSON("default", sources);
  const cm = JSON.parse(cmJSON);
  expect(cm.kind).toBe("ConfigMap");
  expect(cm.metadata.name).toBe("rigel-git-sources");
  expect(cmJSON).not.toContain("token");

  const back = parseGitSources(cm.data["sources.json"]);
  expect(back).toEqual(sources);
});

test("parseGitSources: migrates the legacy flat shape to one deployment named after the old source", () => {
  // Pre-refactor sources.json: each source has a top-level `path`, no `deployments`.
  const legacy = JSON.stringify([
    { name: "rigel-marketing", repoURL: "https://github.com/me/rigel", branch: "master", path: "apps/marketing/k8s", lastSyncedSha: "deadbee", lastStatus: "ok" },
    { name: "bare", repoURL: "https://github.com/me/bare", branch: "main" }, // no path → "."
  ]);
  expect(parseGitSources(legacy)).toEqual([
    {
      name: "rigel-marketing",
      repoURL: "https://github.com/me/rigel",
      branch: "master",
      deployments: [{ name: "rigel-marketing", path: "apps/marketing/k8s", lastSyncedSha: "deadbee", lastStatus: "ok" }],
    },
    {
      name: "bare",
      repoURL: "https://github.com/me/bare",
      branch: "main",
      deployments: [{ name: "bare", path: "." }],
    },
  ]);
});

test("resolveTarget: flattens (repo, deployment) into the clone/apply work-shape", () => {
  const repo: GitSource = {
    name: "monorepo",
    repoURL: "https://github.com/me/monorepo",
    branch: "main",
    deployments: [{ name: "marketing", path: "apps/marketing/k8s" }],
  };
  expect(resolveTarget(repo, repo.deployments[0]!)).toEqual({
    name: "marketing",
    repoURL: "https://github.com/me/monorepo",
    branch: "main",
    path: "apps/marketing/k8s",
  });
});

test("findByDeployment: locates the repo + deployment for a deployment name", () => {
  const sources: GitSource[] = [
    { name: "a", repoURL: "https://github.com/me/a", branch: "main", deployments: [{ name: "a-web", path: "web" }] },
    { name: "b", repoURL: "https://github.com/me/b", branch: "main", deployments: [{ name: "b-api", path: "api" }, { name: "b-ui", path: "ui" }] },
  ];
  expect(findByDeployment(sources, "b-ui")).toEqual({ repo: sources[1]!, dep: sources[1]!.deployments[1]! });
  expect(findByDeployment(sources, "nope")).toBeNull();
});

test("upsertDeployment: appends new names, updates path in place preserving sync state", () => {
  const list = [{ name: "web", path: "web", lastSyncedSha: "abc", lastStatus: "ok" as const }];
  // new name → appended
  expect(upsertDeployment(list, { name: "api", path: "api" })).toEqual([
    { name: "web", path: "web", lastSyncedSha: "abc", lastStatus: "ok" },
    { name: "api", path: "api" },
  ]);
  // existing name → only path changes, lastSynced* preserved
  expect(upsertDeployment(list, { name: "web", path: "deploy/web" })).toEqual([
    { name: "web", path: "deploy/web", lastSyncedSha: "abc", lastStatus: "ok" },
  ]);
});

test("provenanceAnnotations: binds a workload to its synced deployment (name + path)", () => {
  expect(provenanceAnnotations({ name: "marketing", repoURL: "https://github.com/me/r", branch: "main", path: "k8s/prod" })).toEqual([
    `${SOURCE_REPO_ANNOTATION}=marketing`,
    `${SOURCE_PATH_ANNOTATION}=k8s/prod`,
  ]);
  // root path normalizes to "."
  expect(provenanceAnnotations({ name: "marketing", repoURL: "https://github.com/me/r", branch: "main", path: "" })).toEqual([
    `${SOURCE_REPO_ANNOTATION}=marketing`,
    `${SOURCE_PATH_ANNOTATION}=.`,
  ]);
});

test("fixBranchName: rigel/fix-<slug>-<suffix>, falls back to 'change'", () => {
  expect(fixBranchName("Bump api memory limit!", "a1b2c3")).toBe("rigel/fix-bump-api-memory-limit-a1b2c3");
  expect(fixBranchName("", "x9")).toBe("rigel/fix-change-x9");
});

test("safeRepoFilePath: normalizes and rejects traversal/absolute/empty", () => {
  expect(safeRepoFilePath("k8s/api.yaml")).toBe("k8s/api.yaml");
  expect(safeRepoFilePath("/deploy/api.yaml")).toBe("deploy/api.yaml");
  expect(() => safeRepoFilePath("../secrets.yaml")).toThrow();
  expect(() => safeRepoFilePath("a/../../b")).toThrow();
  expect(() => safeRepoFilePath("")).toThrow();
});

test("parseGithubRepos: maps the GitHub API shape and skips junk", () => {
  const api = [
    { full_name: "me/app", default_branch: "main", private: false, clone_url: "https://github.com/me/app.git" },
    { full_name: "org/svc", default_branch: "develop", private: true, clone_url: "https://github.com/org/svc.git" },
    { nope: true },
  ];
  expect(parseGithubRepos(api)).toEqual([
    { fullName: "me/app", defaultBranch: "main", private: false, cloneURL: "https://github.com/me/app.git" },
    { fullName: "org/svc", defaultBranch: "develop", private: true, cloneURL: "https://github.com/org/svc.git" },
  ]);
  expect(parseGithubRepos("nonsense")).toEqual([]);
  expect(parseGithubRepos(null)).toEqual([]);
});

test("githubSecretJSON: account Secret with token + login, named rigel-github", () => {
  const j = JSON.parse(githubSecretJSON("default", "ghp_x", "octocat"));
  expect(j.kind).toBe("Secret");
  expect(j.metadata.name).toBe(GITHUB_SECRET);
  expect(j.stringData).toEqual({ token: "ghp_x", login: "octocat" });
});

test("parseRepoContents: maps dir/file entries, dirs first then alphabetical, drops other types", () => {
  const api = [
    { name: "deploy.yaml", path: "deploy.yaml", type: "file" },
    { name: "base", path: "base", type: "dir" },
    { name: "apps", path: "apps", type: "dir" },
    { name: "link", path: "link", type: "symlink" },
  ];
  expect(parseRepoContents(api)).toEqual([
    { name: "apps", path: "apps", type: "dir" },
    { name: "base", path: "base", type: "dir" },
    { name: "deploy.yaml", path: "deploy.yaml", type: "file" },
  ]);
  expect(parseRepoContents("nope")).toEqual([]);
  expect(parseRepoContents(null)).toEqual([]);
});

test("parseGitSources: tolerates missing/garbage data", () => {
  expect(parseGitSources(undefined)).toEqual([]);
  expect(parseGitSources("")).toEqual([]);
  expect(parseGitSources("not json")).toEqual([]);
  expect(parseGitSources("{}")).toEqual([]);
});
