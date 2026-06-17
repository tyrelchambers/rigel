import { test, expect } from "bun:test";
import {
  sanitizeSourceName,
  normalizeManifestPath,
  parseRepoSlug,
  buildAuthedCloneURL,
  redactURL,
  parseGitSources,
  gitSourcesConfigMapJSON,
  provenanceAnnotations,
  SOURCE_REPO_ANNOTATION,
  SOURCE_PATH_ANNOTATION,
  fixBranchName,
  safeRepoFilePath,
  parseGithubRepos,
  githubSecretJSON,
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

test("parseGitSources / gitSourcesConfigMapJSON: round-trips sources, never carries tokens", () => {
  const sources: GitSource[] = [
    { name: "app-one", repoURL: "https://github.com/me/app-one", branch: "main", path: "k8s" },
    { name: "app-two", repoURL: "https://github.com/me/app-two", branch: "prod", path: ".", lastSyncedSha: "abc123" },
  ];
  const cmJSON = gitSourcesConfigMapJSON("default", sources);
  const cm = JSON.parse(cmJSON);
  expect(cm.kind).toBe("ConfigMap");
  expect(cm.metadata.name).toBe("helmsman-git-sources");
  expect(cmJSON).not.toContain("token");

  const back = parseGitSources(cm.data["sources.json"]);
  expect(back).toEqual(sources);
});

test("provenanceAnnotations: kubectl annotate key=value pairs binding a workload to its source", () => {
  const source: GitSource = { name: "my-app", repoURL: "https://github.com/me/my-app", branch: "main", path: "k8s/prod" };
  expect(provenanceAnnotations(source)).toEqual([
    `${SOURCE_REPO_ANNOTATION}=my-app`,
    `${SOURCE_PATH_ANNOTATION}=k8s/prod`,
  ]);
  // root path normalizes to "."
  expect(provenanceAnnotations({ ...source, path: "" })).toEqual([
    `${SOURCE_REPO_ANNOTATION}=my-app`,
    `${SOURCE_PATH_ANNOTATION}=.`,
  ]);
});

test("fixBranchName: helmsman/fix-<slug>-<suffix>, falls back to 'change'", () => {
  expect(fixBranchName("Bump api memory limit!", "a1b2c3")).toBe("helmsman/fix-bump-api-memory-limit-a1b2c3");
  expect(fixBranchName("", "x9")).toBe("helmsman/fix-change-x9");
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

test("githubSecretJSON: account Secret with token + login, named helmsman-github", () => {
  const j = JSON.parse(githubSecretJSON("default", "ghp_x", "octocat"));
  expect(j.kind).toBe("Secret");
  expect(j.metadata.name).toBe(GITHUB_SECRET);
  expect(j.stringData).toEqual({ token: "ghp_x", login: "octocat" });
});

test("parseGitSources: tolerates missing/garbage data", () => {
  expect(parseGitSources(undefined)).toEqual([]);
  expect(parseGitSources("")).toEqual([]);
  expect(parseGitSources("not json")).toEqual([]);
  expect(parseGitSources("{}")).toEqual([]);
});
