// GitOps source model + pure helpers. A "git source" points Helmsman at a
// GitHub repo whose manifests are deployed on a manual "Sync now". Source
// configs (non-secret) live in the `helmsman-git-sources` ConfigMap; PATs live
// separately in the `helmsman-git-tokens` Secret (key = sanitized source name).
//
// Everything here is pure (no I/O) so it is unit-tested directly; the server's
// git.ts does the cloning/applying and reads/writes the ConfigMap + Secret.

export interface GitSource {
  /** DNS-safe slug; also the repo workdir name and token Secret key. */
  name: string;
  /** Remote URL, e.g. https://github.com/owner/repo(.git). */
  repoURL: string;
  branch: string;
  /** Manifest directory within the repo ("." = root). */
  path: string;
  lastSyncedSha?: string;
  lastSyncedAt?: string;
  lastStatus?: "ok" | "error";
  lastMessage?: string;
}

export const GIT_SOURCES_CONFIGMAP = "helmsman-git-sources";
/** Account-level GitHub PAT (+ login) used to list repos, clone, push, and open PRs. */
export const GITHUB_SECRET = "helmsman-github";
const MANAGED_BY = { "app.kubernetes.io/managed-by": "helmsman" };

/** A repo from the GitHub API, normalized for the add-source picker. */
export interface GithubRepo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  cloneURL: string;
}

// Provenance annotations stamped on every synced resource so a running workload
// can be mapped back to the source repo + manifest dir (used by the AI fix flow).
export const SOURCE_REPO_ANNOTATION = "helmsman.dev/source-repo";
export const SOURCE_PATH_ANNOTATION = "helmsman.dev/source-path";

/** `kubectl annotate key=value` pairs binding a workload to its git source. */
export function provenanceAnnotations(source: GitSource): string[] {
  return [
    `${SOURCE_REPO_ANNOTATION}=${source.name}`,
    `${SOURCE_PATH_ANNOTATION}=${normalizeManifestPath(source.path)}`,
  ];
}

/** Normalize a display name to a DNS-1123-ish slug (lowercase, [a-z0-9-]). */
export function sanitizeSourceName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Normalize a manifest sub-path: default "." (repo root), strip surrounding
 * slashes, and reject any traversal so a source can't escape its checkout.
 */
export function normalizeManifestPath(path: string): string {
  const trimmed = (path ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (trimmed === "" || trimmed === ".") return ".";
  const segments = trimmed.split("/");
  if (segments.some((s) => s === "..")) {
    throw new Error(`manifest path may not contain "..": ${path}`);
  }
  return segments.join("/");
}

/** Branch name for an AI-proposed fix PR: helmsman/fix-<slug>-<suffix>. */
export function fixBranchName(title: string, suffix: string): string {
  const slug =
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "change";
  return `helmsman/fix-${slug}-${suffix}`;
}

/**
 * Validate a manifest FILE path within a repo: strip a leading slash, require a
 * non-empty path, and reject any traversal so a fix can't escape the checkout.
 */
export function safeRepoFilePath(filePath: string): string {
  const trimmed = (filePath ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed === "") throw new Error("file path is required");
  const segments = trimmed.split("/");
  if (segments.some((s) => s === ".." || s === "")) {
    throw new Error(`invalid file path: ${filePath}`);
  }
  return segments.join("/");
}

/** Extract { owner, repo } from an https or scp-style GitHub URL, else null. */
export function parseRepoSlug(repoURL: string): { owner: string; repo: string } | null {
  const cleaned = repoURL.trim().replace(/\.git$/, "");
  // https://github.com/owner/repo  |  git@github.com:owner/repo
  const m = cleaned.match(/github\.com[/:]([^/]+)\/([^/]+)$/);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]! };
}

/**
 * Build the clone/fetch URL with the PAT embedded for HTTPS GitHub. Returns the
 * URL unchanged when no token is given (public repo) — not a fallback, just the
 * anonymous case. NEVER log the result; use redactURL().
 */
export function buildAuthedCloneURL(repoURL: string, token: string | null): string {
  const url = repoURL.trim();
  if (!token) return url;
  if (!url.startsWith("https://")) return url; // ssh/other: token doesn't apply
  return url.replace(/^https:\/\//, `https://x-access-token:${token}@`);
}

/** Mask any embedded `user:secret@` credentials for safe logging/display. */
export function redactURL(url: string): string {
  return url.replace(/(https?:\/\/[^/:@]+:)[^@]+@/, "$1***@");
}

/** Decode the source list from the ConfigMap's `sources.json`. Tolerant. */
export function parseGitSources(dataJSON: string | undefined | null): GitSource[] {
  if (!dataJSON) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(dataJSON);
  } catch {
    return [];
  }
  if (!Array.isArray(obj)) return [];
  return obj.filter(
    (s): s is GitSource =>
      !!s && typeof (s as GitSource).name === "string" && typeof (s as GitSource).repoURL === "string",
  );
}

/** Full ConfigMap JSON for `kubectl apply -f -`. Holds only non-secret config. */
export function gitSourcesConfigMapJSON(namespace: string, sources: GitSource[]): string {
  return JSON.stringify({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: GIT_SOURCES_CONFIGMAP, namespace, labels: MANAGED_BY },
    data: { "sources.json": JSON.stringify(sources) },
  });
}

/** Account Secret JSON (stringData) holding the GitHub PAT + the login it belongs to. */
export function githubSecretJSON(namespace: string, token: string, login: string): string {
  return JSON.stringify({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: GITHUB_SECRET, namespace, labels: MANAGED_BY },
    type: "Opaque",
    stringData: { token, login },
  });
}

/** Map the GitHub `/user/repos` response into our picker shape; skips malformed entries. */
export function parseGithubRepos(json: unknown): GithubRepo[] {
  if (!Array.isArray(json)) return [];
  const out: GithubRepo[] = [];
  for (const r of json) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.full_name !== "string" || typeof o.clone_url !== "string") continue;
    out.push({
      fullName: o.full_name,
      defaultBranch: typeof o.default_branch === "string" ? o.default_branch : "main",
      private: o.private === true,
      cloneURL: o.clone_url,
    });
  }
  return out;
}
