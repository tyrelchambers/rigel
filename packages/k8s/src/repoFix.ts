// Repo-fix core — clone a GitHub repo, write a proposed manifest change, and
// either preview it as a `git diff` or branch/commit/push and open a pull
// request via the GitHub REST API. Extracted out of the server's git.ts so BOTH
// the chat path (apps/server) AND the in-cluster autofix Job (agent) import ONE
// implementation. The only runtime dependency is `runProcess` (git is run via
// the argv runner — no shell); everything else is the pure helpers in
// gitSources.ts. NO server-only or browser-only imports live here, so this is
// safe to import from plain Node in the cluster.
import { rm, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { runProcess } from "./run.js";
import {
  buildAuthedCloneURL,
  fixBranchName,
  parseRepoSlug,
  redactURL,
  safeRepoFilePath,
  type ResolvedTarget,
} from "./gitSources.js";

const REPO_ROOT = `${process.env.TMPDIR ?? "/tmp"}/rigel-repos`;

const runGit = (args: string[]) => runProcess("git", args);

function repoDir(name: string): string {
  return `${REPO_ROOT}/${name}`;
}

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
    "-c", "user.email=rigel@users.noreply.github.com",
    "-c", "user.name=Rigel",
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
      "User-Agent": "rigel",
    },
    body: JSON.stringify(pr),
  });
  const json = (await res.json().catch(() => ({}))) as { html_url?: string; message?: string };
  if (!res.ok) {
    return { ok: false, branch: pr.head, message: `GitHub PR creation failed: ${json.message ?? res.statusText}` };
  }
  return { ok: true, prUrl: json.html_url, branch: pr.head, message: "ok" };
}
