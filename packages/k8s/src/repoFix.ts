// Repo-fix core — clone a GitHub repo, write a proposed manifest change, and
// either preview it as a `git diff` or branch/commit/push and open a pull
// request via the GitHub REST API. Extracted out of the server's git.ts so BOTH
// the chat path (apps/server) AND the in-cluster autofix Job (agent) import ONE
// implementation. The only runtime dependency is `runProcess` (git is run via
// the argv runner — no shell); everything else is the pure helpers in
// gitSources.ts. NO server-only or browser-only imports live here, so this is
// safe to import from plain Node in the cluster.
import { rm, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { planManifestEdit, type ManifestEdit, type ManifestFile, type ManifestTarget } from "./manifestEdit.js";
import { runProcess } from "./run.js";
import {
  buildAuthedCloneURL,
  fixBranchName,
  normalizeManifestPath,
  parseRepoSlug,
  type RepoFixOrigin,
  redactURL,
  safeRepoFilePath,
  type ResolvedTarget,
} from "./gitSources.js";

export type { RepoFixOrigin };

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

/**
 * The change to propose, in one of two shapes, never both:
 *
 * - `filePath` + `content`: the complete replacement file, which is what chat
 *   and the in-cluster agent produce.
 * - `target` + `edit`: the change as an intent. The manifest defining `target`
 *   is located in the checkout and edited here, so nothing has to retype a file
 *   it cannot see. See manifestEdit.ts.
 */
export interface RepoFixInput {
  source: ResolvedTarget;
  token: string | null;
  filePath?: string;
  content?: string;
  target?: Omit<ManifestTarget, "dir">;
  edit?: ManifestEdit;
  title: string;
  body?: string;
  /** Stamps `rigel` + `rigel:<origin>` labels on the PR. Omit to skip labelling. */
  origin?: RepoFixOrigin;
}

export interface RepoFixPreview {
  ok: boolean;
  diff?: string;
  message?: string;
}

export interface RepoFixResult {
  ok: boolean;
  prUrl?: string;
  /** The opened PR's number. */
  number?: number;
  branch?: string;
  /** The file the fix changed, which a typed edit only knows after planning. */
  filePath?: string;
  message?: string;
}

/**
 * Reject a malformed request before anything is cloned: exactly one of the two
 * shapes, and a file path that cannot escape the checkout.
 */
function validateChangeShape(input: RepoFixInput): string | null {
  const hasFile = typeof input.filePath === "string" && typeof input.content === "string";
  const hasEdit = input.target !== undefined && input.edit !== undefined;
  if (hasFile === hasEdit) {
    return "a fix carries either a file path with its new content, or a target with a typed edit, and not both";
  }
  if (hasFile) {
    try {
      safeRepoFilePath(input.filePath!);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
  return null;
}

type ResolvedChange = { ok: true; rel: string; content: string } | { ok: false; message: string };

/**
 * Turn the request into the one file to write, relative to the repo root. The
 * file shape passes straight through; a typed edit reads the source's manifest
 * directory out of the checkout and plans the edit against it.
 */
async function resolveChange(dir: string, input: RepoFixInput): Promise<ResolvedChange> {
  if (typeof input.filePath === "string" && typeof input.content === "string") {
    return { ok: true, rel: safeRepoFilePath(input.filePath), content: input.content };
  }
  const manifestDir = normalizeManifestPath(input.source.path);
  const files = await readManifestFiles(dir, manifestDir);
  const plan = planManifestEdit(files, { ...input.target!, dir: manifestDir }, input.edit!);
  if (!plan.ok) return plan;
  return { ok: true, rel: safeRepoFilePath(plan.filePath), content: plan.content };
}

/** Every manifest under the source's directory, keyed by its repo-relative path. */
async function readManifestFiles(dir: string, manifestDir: string): Promise<ManifestFile[]> {
  const base = manifestDir === "." ? dir : `${dir}/${manifestDir}`;
  let names: string[];
  try {
    names = (await readdir(base, { recursive: true })) as unknown as string[];
  } catch {
    return [];
  }
  const out: ManifestFile[] = [];
  for (const name of names) {
    if (!/\.ya?ml$/i.test(name)) continue;
    const path = manifestDir === "." ? name : `${manifestDir}/${name}`;
    out.push({ path, content: String(await readFile(`${base}/${name}`, "utf8")) });
  }
  return out;
}

/** Clone, write the proposed file, and return the `git diff` (no commit/push). */
export async function previewRepoFix(input: RepoFixInput): Promise<RepoFixPreview> {
  const invalid = validateChangeShape(input);
  if (invalid) return { ok: false, message: invalid };

  const co = await ensureCheckout(input.source, input.token);
  if (!co.ok || !co.dir) return { ok: false, message: co.message };

  const change = await resolveChange(co.dir, input);
  if (!change.ok) return { ok: false, message: change.message };
  const rel = change.rel;

  await writeProposedFile(co.dir, rel, change.content);
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

  const invalid = validateChangeShape(input);
  if (invalid) return { ok: false, message: invalid };

  // Full single-branch clone (not shallow) so pushing the new branch is accepted.
  const co = await ensureCheckout(input.source, input.token, false);
  if (!co.ok || !co.dir) return { ok: false, message: co.message };

  const change = await resolveChange(co.dir, input);
  if (!change.ok) return { ok: false, message: change.message };
  const rel = change.rel;

  const branch = fixBranchName(input.title, randomSuffix());
  const created = await runGit(["-C", co.dir, "checkout", "-b", branch]);
  if (created.code !== 0) return { ok: false, message: created.stderr || "failed to create branch" };

  await writeProposedFile(co.dir, rel, change.content);
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

  const result = await createPullRequest(slug, input.token, {
    title: input.title,
    head: branch,
    base: input.source.branch,
    body: input.body ?? "",
  });
  if (!result.ok) {
    // The branch is pushed but nothing points at it, so take it back rather
    // than leaving a dangling branch behind on the operator's repo.
    await runGit(["-C", co.dir, "push", authed, "--delete", branch]);
    return result;
  }
  if (result.number && input.origin) {
    await labelPullRequest(slug, input.token, result.number, input.origin);
  }
  return { ...result, filePath: rel };
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
  const json = (await res.json().catch(() => ({}))) as { html_url?: string; number?: number; message?: string };
  if (!res.ok) {
    return { ok: false, branch: pr.head, message: `GitHub PR creation failed: ${json.message ?? res.statusText}` };
  }
  return { ok: true, prUrl: json.html_url, number: json.number, branch: pr.head, message: "ok" };
}

/** The provenance labels Rigel stamps on a PR it opened. */
const LABEL_META: Record<string, { color: string; description: string }> = {
  rigel: { color: "38BDF8", description: "Opened by Rigel" },
  "rigel:agent": { color: "A855F7", description: "Opened by the in-cluster Rigel agent" },
  "rigel:chat": { color: "22D3EE", description: "Opened by Rigel from chat" },
  "rigel:voice": { color: "F472B6", description: "Opened by the Rigel voice assistant" },
};

/**
 * Stamp `rigel` + `rigel:<origin>` on the opened PR so its provenance lives on
 * GitHub, not only in cluster state. Best-effort: labels need write access and
 * must exist before they can be applied, so every failure here is swallowed —
 * a PR that could not be labelled is still a successfully opened PR.
 */
export async function labelPullRequest(
  slug: { owner: string; repo: string },
  token: string,
  number: number,
  origin: RepoFixOrigin,
): Promise<void> {
  const labels = ["rigel", `rigel:${origin}`];
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "rigel",
  };
  try {
    // Create each label first; an "already exists" 422 is the expected steady state.
    for (const name of labels) {
      await fetch(`https://api.github.com/repos/${slug.owner}/${slug.repo}/labels`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name, ...LABEL_META[name] }),
      });
    }
    await fetch(`https://api.github.com/repos/${slug.owner}/${slug.repo}/issues/${number}/labels`, {
      method: "POST",
      headers,
      body: JSON.stringify({ labels }),
    });
  } catch {
    /* best-effort: never fail the PR over a label */
  }
}
