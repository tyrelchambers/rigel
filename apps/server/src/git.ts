// GitOps server I/O — clone a GitHub repo, diff/apply its manifests, and persist
// source configs in-cluster. Source list lives in the `helmsman-git-sources`
// ConfigMap; a single account-level GitHub PAT (+ login) lives in the
// `helmsman-github` Secret and drives repo listing, clone, push, and PRs. Repos
// are shallow-cloned fresh into /tmp on each sync (manifests are small).
//
// Reuses the existing apply pipeline conventions: kubectl is run via the argv
// runner (no shell), manifests applied with `kubectl apply -f <dir> -R`, and a
// `kubectl diff` provides the pre-apply preview surfaced in the UI.
import { rm, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { kubectl, runProcess, type RunResult } from "@helmsman/k8s/src/run";
import {
  GIT_SOURCES_CONFIGMAP,
  GITHUB_SECRET,
  buildAuthedCloneURL,
  fixBranchName,
  gitSourcesConfigMapJSON,
  githubSecretJSON,
  normalizeManifestPath,
  parseGitSources,
  parseGithubRepos,
  parseRepoContents,
  parseRepoSlug,
  provenanceAnnotations,
  redactURL,
  safeRepoFilePath,
  type GitSource,
  type ResolvedTarget,
  type GithubRepo,
  type RepoEntry,
} from "@helmsman/k8s/src/gitSources";
import { applyManifest } from "./install";

const STATE_NAMESPACE = process.env.HELMSMAN_NAMESPACE ?? "default";
const REPO_ROOT = `${process.env.TMPDIR ?? "/tmp"}/helmsman-repos`;

const runGit = (args: string[]) => runProcess("git", args);

function repoDir(name: string): string {
  return `${REPO_ROOT}/${name}`;
}

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
    "User-Agent": "helmsman",
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

export interface CheckoutResult {
  ok: boolean;
  sha?: string;
  dir?: string;
  message: string;
}

/**
 * Shallow-clone the target's branch fresh into /tmp and return the checked-out
 * directory + HEAD sha. The token is embedded only for the clone, then scrubbed
 * from the stored remote so it isn't left at rest in .git/config.
 */
export async function ensureCheckout(
  target: ResolvedTarget,
  token: string | null,
  shallow = true,
): Promise<CheckoutResult> {
  const dir = repoDir(target.name);
  const authed = buildAuthedCloneURL(target.repoURL, token);
  await rm(dir, { recursive: true, force: true });
  await mkdir(REPO_ROOT, { recursive: true });

  const depth = shallow ? ["--depth", "1"] : [];
  const clone = await runGit(["clone", ...depth, "--single-branch", "--branch", target.branch, authed, dir]);
  if (clone.code !== 0) {
    return { ok: false, message: redactURL(clone.stderr || clone.stdout || "git clone failed") };
  }
  // Scrub the token from the persisted remote.
  await runGit(["-C", dir, "remote", "set-url", "origin", target.repoURL]);

  const head = await runGit(["-C", dir, "rev-parse", "HEAD"]);
  const sha = head.code === 0 ? head.stdout.trim() : undefined;
  return { ok: true, sha, dir, message: "ok" };
}

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

// ---------------------------------------------------------------------------
// AI fix → pull request (feature 3c)
// ---------------------------------------------------------------------------

export interface RepoFixInput {
  source: ResolvedTarget;
  token: string | null;
  filePath: string;
  content: string;
  title: string;
  body?: string;
}

export interface RepoFixPreview {
  ok: boolean;
  diff?: string;
  message?: string;
}

export interface RepoFixResult {
  ok: boolean;
  prUrl?: string;
  branch?: string;
  message?: string;
}

/** Clone, write the proposed file, and return the `git diff` (no commit/push). */
export async function previewRepoFix(input: RepoFixInput): Promise<RepoFixPreview> {
  let rel: string;
  try {
    rel = safeRepoFilePath(input.filePath);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  const co = await ensureCheckout(input.source, input.token);
  if (!co.ok || !co.dir) return { ok: false, message: co.message };

  await writeProposedFile(co.dir, rel, input.content);
  // --intent-to-add makes brand-new files show up in `git diff`.
  await runGit(["-C", co.dir, "add", "--intent-to-add", rel]);
  const diff = await runGit(["-C", co.dir, "diff", "--", rel]);
  return { ok: true, diff: diff.stdout || "(new file — no prior version)" };
}

/** Clone, branch, commit the fix, push, and open a PR via the GitHub REST API. */
export async function proposeRepoFix(input: RepoFixInput): Promise<RepoFixResult> {
  const slug = parseRepoSlug(input.source.repoURL);
  if (!slug) return { ok: false, message: "could not parse owner/repo from the source repoURL" };
  if (!input.token) return { ok: false, message: "a token with repo + pull-request scope is required to open a PR" };

  let rel: string;
  try {
    rel = safeRepoFilePath(input.filePath);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }

  // Full single-branch clone (not shallow) so pushing the new branch is accepted.
  const co = await ensureCheckout(input.source, input.token, false);
  if (!co.ok || !co.dir) return { ok: false, message: co.message };

  const branch = fixBranchName(input.title, randomSuffix());
  const created = await runGit(["-C", co.dir, "checkout", "-b", branch]);
  if (created.code !== 0) return { ok: false, message: created.stderr || "failed to create branch" };

  await writeProposedFile(co.dir, rel, input.content);
  await runGit(["-C", co.dir, "add", rel]);
  const commit = await runGit([
    "-C", co.dir,
    "-c", "user.email=helmsman@users.noreply.github.com",
    "-c", "user.name=Helmsman",
    "commit", "-m", input.title,
  ]);
  if (commit.code !== 0) {
    return { ok: false, message: commit.stderr || commit.stdout || "nothing to commit (file unchanged?)" };
  }

  // Push using the authed URL directly (the stored remote was scrubbed).
  const authed = buildAuthedCloneURL(input.source.repoURL, input.token);
  const push = await runGit(["-C", co.dir, "push", authed, `${branch}:${branch}`]);
  if (push.code !== 0) return { ok: false, branch, message: redactURL(push.stderr || "git push failed") };

  return createPullRequest(slug, input.token, {
    title: input.title,
    head: branch,
    base: input.source.branch,
    body: input.body ?? "",
  });
}

async function writeProposedFile(dir: string, rel: string, content: string): Promise<void> {
  const abs = `${dir}/${rel}`;
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

async function createPullRequest(
  slug: { owner: string; repo: string },
  token: string,
  pr: { title: string; head: string; base: string; body: string },
): Promise<RepoFixResult> {
  const res = await fetch(`https://api.github.com/repos/${slug.owner}/${slug.repo}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "helmsman",
    },
    body: JSON.stringify(pr),
  });
  const json = (await res.json().catch(() => ({}))) as { html_url?: string; message?: string };
  if (!res.ok) {
    return { ok: false, branch: pr.head, message: `GitHub PR creation failed: ${json.message ?? res.statusText}` };
  }
  return { ok: true, prUrl: json.html_url, branch: pr.head, message: "ok" };
}
