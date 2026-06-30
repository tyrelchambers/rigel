// GitOps server I/O — clone a GitHub repo, diff/apply its manifests, and persist
// source configs in-cluster. Source list lives in the `rigel-git-sources`
// ConfigMap; a single account-level GitHub PAT (+ login) lives in the
// `rigel-github` Secret and drives repo listing, clone, push, and PRs. Repos
// are shallow-cloned fresh into /tmp on each sync (manifests are small).
//
// Reuses the existing apply pipeline conventions: kubectl is run via the argv
// runner (no shell), manifests applied with `kubectl apply -f <dir> -R`, and a
// `kubectl diff` provides the pre-apply preview surfaced in the UI.
import { createHash } from "node:crypto";
import { kubectl, type RunResult } from "@rigel/k8s/src/run";
import {
  GIT_SOURCES_CONFIGMAP,
  GITHUB_SECRET,
  gitSourcesConfigMapJSON,
  githubSecretJSON,
  normalizeManifestPath,
  parseGitSources,
  parseGithubRepos,
  parseRepoContents,
  parseRepoSlug,
  provenanceAnnotations,
  resolveRepoLink,
  sanitizeSourceName,
  findByDeployment,
  upsertDeployment,
  safeRepoFilePath,
  type GitSource,
  type ResolvedTarget,
  type GithubRepo,
  type RepoEntry,
  type RepoLink,
} from "@rigel/k8s/src/gitSources";
// Repo-fix core (clone → branch → commit → push → open PR) now lives in
// @rigel/k8s so the in-cluster agent Job and this chat path share ONE
// implementation. ensureCheckout is used below by diffSource/applySource;
// the rest is re-exported so callers keep importing it from "./git" unchanged.
import { ensureCheckout } from "@rigel/k8s/src/repoFix";
export {
  ensureCheckout,
  previewRepoFix,
  proposeRepoFix,
  type CheckoutResult,
  type RepoFixInput,
  type RepoFixPreview,
  type RepoFixResult,
} from "@rigel/k8s/src/repoFix";
import { applyManifest } from "./install";

const STATE_NAMESPACE = process.env.HELMSMAN_NAMESPACE ?? "default";

// ---------------------------------------------------------------------------
// State: source list (ConfigMap) + tokens (Secret)
// ---------------------------------------------------------------------------

/** Read the configured sources from the ConfigMap (empty when absent). */
export async function loadSources(context: string | null): Promise<GitSource[]> {
  const res = await kubectl(context, ["get", "configmap", GIT_SOURCES_CONFIGMAP, "-n", STATE_NAMESPACE, "-o", "json"]);
  if (res.code !== 0) return []; // NotFound → no sources yet
  try {
    const cm = JSON.parse(res.stdout) as { data?: Record<string, string> };
    return parseGitSources(cm.data?.["sources.json"]);
  } catch {
    return [];
  }
}

/** Persist the full source list (apply the ConfigMap). */
export async function saveSources(context: string | null, sources: GitSource[]): Promise<RunResult> {
  return applyManifest(context, gitSourcesConfigMapJSON(STATE_NAMESPACE, sources));
}

// ---------------------------------------------------------------------------
// "Link to repo" — bind a running Deployment to a GitOps source (no redeploy)
// ---------------------------------------------------------------------------

/** Input for linking one running Deployment to a repo + manifest path. */
export interface LinkRepoInput {
  /** The Deployment's namespace (where the annotation is stamped). */
  namespace: string;
  /** The Deployment name to link + stamp. */
  deployment: string;
  /** Remote repo URL, e.g. https://github.com/owner/repo(.git). */
  repoURL: string;
  branch?: string;
  /** Manifest directory within the repo ("." = root). */
  path?: string;
}

/** What was linked, for the API response + the UI's link status. */
export interface LinkRepoResult {
  ok: boolean;
  /** The deployment's provenance id == the stamped rigel.dev/source-repo value. */
  source: string;
  /** "owner/name" parsed from the repo URL. */
  repo: string;
  /** The git-source slug the deployment lives under. */
  repoName: string;
  repoURL: string;
  branch: string;
  path: string;
}

/** The result of planning a link: the source list to persist + the annotate to run. */
export interface RepoLinkPlan {
  sources: GitSource[];
  annotate: { namespace: string; deployment: string; args: string[] };
  result: LinkRepoResult;
}

/**
 * A cluster WRITE failed (saveSources / `kubectl annotate`) — distinct from a
 * validation/collision error so the API can map it to 5xx rather than 422
 * (bad-input). Carries the kubectl detail in `.message` (never a secret).
 */
export class ClusterWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClusterWriteError";
  }
}

/** Kubernetes object-name limit; the provenance id doubles as a resource name. */
const MAX_NAME_LEN = 63;

/**
 * Derive the collision-resistant provenance id for a (namespace, deployment)
 * pair. It doubles as the GitDeployment name, the `/tmp/rigel-repos/<name>`
 * workdir, AND the `rigel.dev/source-repo` annotation value, so it must be
 * DNS-1123 (lowercase [a-z0-9-], <=63 chars) and can't contain "/".
 *
 * A naive `<ns>-<deployment>` slug is AMBIGUOUS — dashes are legal in both, so
 * (prod, web-api) and (prod-web, api) both collapse to `prod-web-api` and would
 * silently merge into one GitDeployment. We disambiguate by appending the first
 * 7 hex of sha256("<ns>/<deployment>") (the EXACT, unsanitized pair), which
 * collides only on a true sha256 collision. Deterministic, so re-linking the
 * same workload upserts the same entry. The slug prefix is truncated (never the
 * hash) to stay within 63 chars.
 */
export function provenanceId(namespace: string, deployment: string): string {
  const ns = (namespace ?? "").trim();
  const dep = (deployment ?? "").trim();
  const hash = createHash("sha256").update(`${ns}/${dep}`).digest("hex").slice(0, 7);
  const slug = sanitizeSourceName(`${ns}-${dep}`);
  // Reserve room for "-<hash>"; trim a trailing dash so we never produce "--".
  const prefix = slug.slice(0, MAX_NAME_LEN - hash.length - 1).replace(/-+$/, "");
  return prefix ? `${prefix}-${hash}` : hash;
}

/** Whether two repo URLs name the same repo (ignoring a trailing .git / slash). */
function sameRepoURL(a: string, b: string): boolean {
  const norm = (u: string) => (u ?? "").trim().replace(/\.git$/, "").replace(/\/+$/, "");
  return norm(a) === norm(b);
}

/**
 * Pure planner for "Link to repo": derive the deterministic source slug + the
 * collision-resistant deployment provenance id from (repoURL, namespace,
 * deployment), create-or-extend the matching `rigel-git-sources` entry with a
 * deployment at `path`, and compute the provenance annotation pairs to stamp on
 * the workload. The provenance id is BOTH the GitDeployment name AND the
 * rigel.dev/source-repo value, so the agent's repoResolve can map the workload
 * back to this source.
 *
 * Reuses the existing source primitives (parseRepoSlug / sanitizeSourceName /
 * upsertDeployment / findByDeployment / provenanceAnnotations) — no duplicated
 * write logic. Throws (plain Error → HTTP 422) on a bad repoURL, missing ids, a
 * cross-repo collision, or a source-slug clash with a different repo URL.
 */
export function planRepoLink(sources: GitSource[], input: LinkRepoInput): RepoLinkPlan {
  const repoURL = (input.repoURL ?? "").trim();
  if (repoURL === "") throw new Error("repoURL is required");
  const ns = (input.namespace ?? "").trim();
  const deployment = (input.deployment ?? "").trim();
  if (ns === "" || deployment === "") throw new Error("namespace and deployment are required");

  const slug = parseRepoSlug(repoURL);
  if (!slug) throw new Error(`could not parse owner/repo from repoURL: ${repoURL}`);
  const repoName = sanitizeSourceName(`${slug.owner}-${slug.repo}`);
  if (repoName === "") throw new Error("could not derive a source slug from the repo URL");
  // Collision-resistant provenance id (see provenanceId): stamped on the workload
  // + used as the GitDeployment name so resolveWorkloadRepo/resolveRepoLink
  // resolve it back. Never empty (the hash is always present).
  const source = provenanceId(ns, deployment);
  const path = normalizeManifestPath(input.path ?? ".");

  // A deployment id is a global key — it can't already belong to a DIFFERENT repo.
  const owner = findByDeployment(sources, source);
  if (owner && owner.repo.name !== repoName) {
    throw new Error(`deployment id "${source}" is already linked to repo "${owner.repo.name}"`);
  }

  // Two different repo URLs can sanitize to the SAME slug (e.g. me/my_app and
  // me/my-app → "me-my-app"). Reusing that slug for a different URL would silently
  // repoint the existing source's OTHER deployments — refuse instead of repoint.
  const existing = sources.find((s) => s.name === repoName);
  if (existing && !sameRepoURL(existing.repoURL, repoURL)) {
    throw new Error(
      `source slug "${repoName}" is already used by ${existing.repoURL}; cannot link a different repo (${repoURL}) under the same slug`,
    );
  }

  const branch = (input.branch ?? "").trim() || existing?.branch || "main";
  const deployments = upsertDeployment(existing?.deployments ?? [], { name: source, path });
  const next: GitSource = { name: repoName, repoURL, branch, deployments };
  const merged = existing ? sources.map((s) => (s.name === repoName ? next : s)) : [...sources, next];

  return {
    sources: merged,
    annotate: {
      namespace: ns,
      deployment,
      args: provenanceAnnotations({ name: source, repoURL, branch, path }),
    },
    result: { ok: true, source, repo: `${slug.owner}/${slug.repo}`, repoName, repoURL, branch, path },
  };
}

/**
 * Link a running Deployment to a GitOps source: persist the create-or-extend
 * `rigel-git-sources` entry (reusing saveSources) AND stamp the live Deployment
 * with the provenance annotations via `kubectl annotate --overwrite` — no
 * redeploy. Idempotent (upsert + --overwrite), so a retry after a partial failure
 * recovers. A planning/validation problem throws a plain Error (→ 422); a cluster
 * write failure throws ClusterWriteError (→ 5xx).
 */
export async function linkRepo(context: string | null, input: LinkRepoInput): Promise<LinkRepoResult> {
  const sources = await loadSources(context);
  const plan = planRepoLink(sources, input); // plain Error on bad input → 422
  const saved = await saveSources(context, plan.sources);
  if (saved.code !== 0) throw new ClusterWriteError(saved.stderr || saved.stdout || "failed to save the git source");
  const stamp = await kubectl(context, [
    "annotate",
    "deployment",
    plan.annotate.deployment,
    "-n",
    plan.annotate.namespace,
    ...plan.annotate.args,
    "--overwrite",
  ]);
  if (stamp.code !== 0) {
    throw new ClusterWriteError(
      `linked the source, but stamping the Deployment failed: ${stamp.stderr || stamp.stdout || `exit ${stamp.code}`}`,
    );
  }
  return plan.result;
}

/**
 * Resolve whether a Deployment is repo-linked — the read path the UI uses for
 * per-project link status. Reads the workload's provenance annotations, then
 * resolves them against the configured sources via the shared resolveRepoLink
 * (same semantics as the agent's resolveWorkloadRepo). Unlinked (link: null) when
 * the Deployment is missing/unreadable, unstamped, or names a vanished source.
 */
export async function resolveDeploymentLink(
  context: string | null,
  namespace: string,
  deployment: string,
): Promise<{ linked: boolean; link: RepoLink | null }> {
  const res = await kubectl(context, ["get", "deployment", deployment, "-n", namespace, "-o", "json"]);
  if (res.code !== 0) return { linked: false, link: null };
  let annotations: Record<string, string> = {};
  try {
    annotations =
      (JSON.parse(res.stdout) as { metadata?: { annotations?: Record<string, string> } }).metadata?.annotations ?? {};
  } catch {
    return { linked: false, link: null };
  }
  const link = resolveRepoLink(await loadSources(context), annotations);
  return { linked: link !== null, link };
}

// ---------------------------------------------------------------------------
// Account-level GitHub token: one PAT for listing repos + clone/push/PR.
// ---------------------------------------------------------------------------

async function readGithubSecret(context: string | null): Promise<{ token: string | null; login: string | null }> {
  const res = await kubectl(context, ["get", "secret", GITHUB_SECRET, "-n", STATE_NAMESPACE, "-o", "json"]);
  if (res.code !== 0) return { token: null, login: null };
  try {
    const secret = JSON.parse(res.stdout) as { data?: Record<string, string> };
    const dec = (k: string) => (secret.data?.[k] ? Buffer.from(secret.data[k]!, "base64").toString("utf8") : null);
    return { token: dec("token"), login: dec("login") };
  } catch {
    return { token: null, login: null };
  }
}

/** The stored GitHub PAT, or null — used by every clone/push/PR operation. */
export async function loadGithubToken(context: string | null): Promise<string | null> {
  return (await readGithubSecret(context)).token;
}

/** Connection status for the UI: a PAT is stored + which login it belongs to. */
export async function githubAccountStatus(
  context: string | null,
): Promise<{ connected: boolean; login: string | null }> {
  const acct = await readGithubSecret(context);
  return { connected: acct.token != null, login: acct.login };
}

/** Validate a PAT against the GitHub API, then store it (with its login). */
export async function connectGithub(
  context: string | null,
  token: string,
): Promise<{ ok: boolean; login?: string; message?: string }> {
  const user = await githubUser(token);
  if (!user.ok || !user.login) return { ok: false, message: user.message ?? "invalid token" };
  const res = await applyManifest(context, githubSecretJSON(STATE_NAMESPACE, token, user.login));
  if (res.code !== 0) return { ok: false, message: res.stderr || "failed to store token" };
  return { ok: true, login: user.login };
}

/** Remove the stored PAT. */
export async function disconnectGithub(context: string | null): Promise<RunResult> {
  return kubectl(context, ["delete", "secret", GITHUB_SECRET, "-n", STATE_NAMESPACE, "--ignore-not-found"]);
}

// --- GitHub REST helpers (no SDK; fetch + PAT) ------------------------------

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "rigel",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** GET /user → { ok, login }. Validates the token. */
async function githubUser(token: string): Promise<{ ok: boolean; login?: string; message?: string }> {
  try {
    const res = await fetch("https://api.github.com/user", { headers: githubHeaders(token) });
    const j = (await res.json().catch(() => ({}))) as { login?: string; message?: string };
    if (!res.ok) return { ok: false, message: j.message ?? `GitHub ${res.status}` };
    return { ok: true, login: j.login };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * List one directory level of a repo (GitHub contents API) — the add-source
 * folder browser. `ownerRepo` is "owner/repo"; empty path = repo root.
 */
export async function listRepoTree(
  token: string,
  ownerRepo: string,
  branch: string,
  path: string,
): Promise<RepoEntry[]> {
  const [owner, repo] = ownerRepo.split("/");
  if (!owner || !repo) return [];
  const clean = path.replace(/^\/+|\/+$/g, "");
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${clean}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: githubHeaders(token) });
  if (!res.ok) return [];
  return parseRepoContents(await res.json().catch(() => []));
}

/** Read a single file's text from a repo via the GitHub contents API — mirrors
 *  listRepoTree but for one blob. Returns the decoded UTF-8 content. Path is
 *  guarded by safeRepoFilePath (no traversal). */
export async function readRepoFile(
  token: string,
  ownerRepo: string,
  branch: string,
  path: string,
): Promise<{ ok: boolean; content?: string; message?: string }> {
  let rel: string;
  try {
    rel = safeRepoFilePath(path);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  const [owner, repo] = ownerRepo.split("/");
  if (!owner || !repo) return { ok: false, message: "bad repo" };
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${rel}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: githubHeaders(token) });
  if (!res.ok) return { ok: false, message: `GitHub ${res.status}` };
  const j = (await res.json().catch(() => ({}))) as { content?: string; encoding?: string };
  if (typeof j.content !== "string") return { ok: false, message: "not a file" };
  const decoded = j.encoding === "base64" ? Buffer.from(j.content, "base64").toString("utf8") : j.content;
  return { ok: true, content: decoded };
}

/** List the user's repos (follows Link pagination, capped), newest-updated first. */
export async function listGithubRepos(token: string): Promise<GithubRepo[]> {
  const out: GithubRepo[] = [];
  let url: string | null =
    "https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member";
  for (let page = 0; url && page < 10; page++) {
    const res: Response = await fetch(url, { headers: githubHeaders(token) });
    if (!res.ok) break;
    out.push(...parseGithubRepos(await res.json().catch(() => [])));
    url = nextLink(res.headers.get("link"));
  }
  return out;
}

/** Extract the `rel="next"` URL from a GitHub Link header, or null. */
function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1]!;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Repo operations
// ---------------------------------------------------------------------------

/** Absolute manifest directory for a checked-out target. */
function manifestDir(dir: string, target: ResolvedTarget): string {
  const path = normalizeManifestPath(target.path);
  return path === "." ? dir : `${dir}/${path}`;
}

export interface GitOpResult extends RunResult {
  sha?: string;
}

/**
 * Clone + `kubectl diff -f <dir> -R` (the pre-apply preview). kubectl diff exits
 * 1 when differences exist and 0 when none — both are success here; >1 is error.
 */
export async function diffSource(context: string | null, target: ResolvedTarget, token: string | null): Promise<GitOpResult> {
  const co = await ensureCheckout(target, token);
  if (!co.ok || !co.dir) return { code: 1, stdout: "", stderr: co.message };
  const res = await kubectl(context, ["diff", "-f", manifestDir(co.dir, target), "-R"]);
  // Normalize: diff-present (1) is not an error for our purposes.
  const code = res.code === 1 ? 0 : res.code;
  return { code, stdout: res.stdout, stderr: res.stderr, sha: co.sha };
}

/** Clone + `kubectl apply -f <dir> -R`. Returns the apply result + synced sha. */
export async function applySource(context: string | null, target: ResolvedTarget, token: string | null): Promise<GitOpResult> {
  const co = await ensureCheckout(target, token);
  if (!co.ok || !co.dir) return { code: 1, stdout: "", stderr: co.message };
  const dir = manifestDir(co.dir, target);
  const res = await kubectl(context, ["apply", "-f", dir, "-R"]);
  if (res.code === 0) {
    // Best-effort provenance: stamp the synced resources so they map back to
    // this deployment (the AI fix flow reads these annotations). A failure here
    // must not fail the sync itself.
    await kubectl(context, ["annotate", "-f", dir, "-R", ...provenanceAnnotations(target), "--overwrite"]);
  }
  return { ...res, sha: co.sha };
}
