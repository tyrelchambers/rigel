// GitOps source model + pure helpers. A "git source" points Rigel at a
// GitHub repo whose manifests are deployed on a manual "Sync now". Source
// configs (non-secret) live in the `rigel-git-sources` ConfigMap; PATs live
// separately in the `rigel-git-tokens` Secret (key = sanitized source name).
//
// Everything here is pure (no I/O) so it is unit-tested directly; the server's
// git.ts does the cloning/applying and reads/writes the ConfigMap + Secret.

/**
 * One independently-syncable manifest directory within a repo. The `name` is the
 * unit of sync, the `/tmp/rigel-repos/<name>` workdir, and the provenance id
 * stamped on synced workloads — so it is globally unique across all repos.
 */
export interface GitDeployment {
  /** Globally-unique DNS slug; workdir name + provenance id. */
  name: string;
  /** Manifest directory within the repo ("." = root). */
  path: string;
  lastSyncedSha?: string;
  lastSyncedAt?: string;
  lastStatus?: "ok" | "error";
  lastMessage?: string;
}

/** A GitOps source = one repo plus its independently-deployable manifest dirs. */
export interface GitSource {
  /** DNS-safe slug identifying the repo. */
  name: string;
  /** Remote URL, e.g. https://github.com/owner/repo(.git). */
  repoURL: string;
  branch: string;
  /** One or more independently-syncable deployments in this repo. */
  deployments: GitDeployment[];
}

/**
 * The flat work-shape the clone/diff/apply helpers operate on: one deployment
 * resolved against its repo. Structurally the legacy single-path source, so the
 * server's checkout/diff/apply logic is unchanged.
 */
export interface ResolvedTarget {
  name: string;
  repoURL: string;
  branch: string;
  path: string;
}

/** Flatten a (repo, deployment) pair into the work-shape the server helpers take. */
export function resolveTarget(repo: GitSource, dep: GitDeployment): ResolvedTarget {
  return { name: dep.name, repoURL: repo.repoURL, branch: repo.branch, path: dep.path };
}

/**
 * Upsert a deployment into a list by name. When the name already exists, only its
 * `path` changes — the entry's `lastSynced*` state is preserved (so editing a
 * deployment's folder doesn't wipe its sync history).
 */
export function upsertDeployment(list: GitDeployment[], dep: { name: string; path: string }): GitDeployment[] {
  const idx = list.findIndex((d) => d.name === dep.name);
  if (idx === -1) return [...list, { name: dep.name, path: dep.path }];
  const next = list.slice();
  next[idx] = { ...list[idx]!, path: dep.path };
  return next;
}

/** Find the repo + deployment owning a (globally-unique) deployment name, or null. */
export function findByDeployment(
  sources: GitSource[],
  deploymentName: string,
): { repo: GitSource; dep: GitDeployment } | null {
  for (const repo of sources) {
    const dep = repo.deployments.find((d) => d.name === deploymentName);
    if (dep) return { repo, dep };
  }
  return null;
}

export const GIT_SOURCES_CONFIGMAP = "rigel-git-sources";
/** Account-level GitHub PAT (+ login) used to list repos, clone, push, and open PRs. */
export const GITHUB_SECRET = "rigel-github";
const MANAGED_BY = { "app.kubernetes.io/managed-by": "rigel" };

/** A repo from the GitHub API, normalized for the add-source picker. */
export interface GithubRepo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  cloneURL: string;
}

/** One entry in a repo directory listing (GitHub contents API). */
export interface RepoEntry {
  name: string;
  path: string;
  type: "dir" | "file";
}

// Provenance annotations stamped on every synced resource so a running workload
// can be mapped back to the source repo + manifest dir (used by the AI fix flow).
export const SOURCE_REPO_ANNOTATION = "rigel.dev/source-repo";
export const SOURCE_PATH_ANNOTATION = "rigel.dev/source-path";

/** `kubectl annotate key=value` pairs binding a workload to its synced deployment. */
export function provenanceAnnotations(target: ResolvedTarget): string[] {
  return [
    `${SOURCE_REPO_ANNOTATION}=${target.name}`,
    `${SOURCE_PATH_ANNOTATION}=${normalizeManifestPath(target.path)}`,
  ];
}

/** A workload's resolved GitOps link, for the UI's per-project link status. */
export interface RepoLink {
  /** The matched deployment slug (== the rigel.dev/source-repo annotation value). */
  source: string;
  repoURL: string;
  /** "owner/name" parsed from the repo URL, or null for a non-GitHub URL. */
  repo: string | null;
  branch: string;
  /** Manifest directory the linked deployment tracks. */
  path: string;
}

/**
 * Resolve a workload's GitOps link from its Deployment annotations + the
 * configured sources — the read side of the "Link to repo" flow. Mirrors the
 * agent's resolveWorkloadRepo (agent/src/repoResolve.ts) resolution semantics:
 * the rigel.dev/source-repo annotation names a deployment slug, looked up in the
 * sources via findByDeployment; a stamped source-path overrides the configured
 * one. Returns null (unlinked) when not provenance-stamped or the source is gone.
 * Pure — no I/O — so it is unit-testable; the server does the kubectl reads.
 */
export function resolveRepoLink(
  sources: GitSource[],
  annotations: Record<string, string> | undefined | null,
): RepoLink | null {
  const ann = annotations ?? {};
  const source = (ann[SOURCE_REPO_ANNOTATION] ?? "").trim();
  if (!source) return null; // not provenance-stamped → not tracked by GitOps
  const stampedPath = (ann[SOURCE_PATH_ANNOTATION] ?? "").trim();
  const match = findByDeployment(sources, source);
  if (!match) return null; // annotated, but the source is gone from the ConfigMap
  const slug = parseRepoSlug(match.repo.repoURL);
  return {
    source,
    repoURL: match.repo.repoURL,
    repo: slug ? `${slug.owner}/${slug.repo}` : null,
    branch: match.repo.branch,
    path: stampedPath || match.dep.path,
  };
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

/** Branch name for an AI-proposed fix PR: rigel/fix-<slug>-<suffix>. */
export function fixBranchName(title: string, suffix: string): string {
  const slug =
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "change";
  return `rigel/fix-${slug}-${suffix}`;
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

/** Coerce one stored deployment entry, keeping only known fields; null if unusable. */
function normalizeDeployment(raw: unknown): GitDeployment | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== "string") return null;
  const dep: GitDeployment = { name: o.name, path: typeof o.path === "string" ? o.path : "." };
  if (typeof o.lastSyncedSha === "string") dep.lastSyncedSha = o.lastSyncedSha;
  if (typeof o.lastSyncedAt === "string") dep.lastSyncedAt = o.lastSyncedAt;
  if (o.lastStatus === "ok" || o.lastStatus === "error") dep.lastStatus = o.lastStatus;
  if (typeof o.lastMessage === "string") dep.lastMessage = o.lastMessage;
  return dep;
}

/**
 * Coerce one stored source entry to the current repo→deployments shape. A legacy
 * flat source ({…, path, lastSynced*}) is migrated to a single deployment named
 * after the old source, so existing provenance annotations keep resolving.
 */
function normalizeSource(raw: unknown): GitSource | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== "string" || typeof o.repoURL !== "string") return null;
  const branch = typeof o.branch === "string" ? o.branch : "main";
  if (Array.isArray(o.deployments)) {
    const deployments = o.deployments
      .map(normalizeDeployment)
      .filter((d): d is GitDeployment => d !== null);
    return { name: o.name, repoURL: o.repoURL, branch, deployments };
  }
  const dep = normalizeDeployment(o); // legacy: o carries name + path + lastSynced*
  return { name: o.name, repoURL: o.repoURL, branch, deployments: dep ? [dep] : [] };
}

/** Decode the source list from the ConfigMap's `sources.json`. Tolerant; migrates
 *  the legacy single-path shape to repo→deployments on read. */
export function parseGitSources(dataJSON: string | undefined | null): GitSource[] {
  if (!dataJSON) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(dataJSON);
  } catch {
    return [];
  }
  if (!Array.isArray(obj)) return [];
  return obj.map(normalizeSource).filter((s): s is GitSource => s !== null);
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

/**
 * Map a GitHub contents-API directory listing into {name, path, type} entries,
 * keeping only dirs/files, sorted dirs-first then alphabetical by name. Used by
 * the add-source folder browser (one level per request).
 */
export function parseRepoContents(json: unknown): RepoEntry[] {
  if (!Array.isArray(json)) return [];
  const out: RepoEntry[] = [];
  for (const e of json) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    if (typeof o.name !== "string" || typeof o.path !== "string") continue;
    if (o.type !== "dir" && o.type !== "file") continue;
    out.push({ name: o.name, path: o.path, type: o.type });
  }
  return out.sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
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
