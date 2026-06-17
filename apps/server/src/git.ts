// GitOps server I/O — clone a GitHub repo, diff/apply its manifests, and persist
// source configs in-cluster. Source list lives in the `helmsman-git-sources`
// ConfigMap; PATs live in the `helmsman-git-tokens` Secret. Repos are shallow-
// cloned fresh into /tmp on each sync (manifests are small; avoids stale state).
//
// Reuses the existing apply pipeline conventions: kubectl is run via the argv
// runner (no shell), manifests applied with `kubectl apply -f <dir> -R`, and a
// `kubectl diff` provides the pre-apply preview surfaced in the UI.
import { rm, mkdir } from "node:fs/promises";
import { kubectl, runProcess, type RunResult } from "@helmsman/k8s/src/run";
import {
  GIT_SOURCES_CONFIGMAP,
  GIT_TOKENS_SECRET,
  buildAuthedCloneURL,
  gitSourcesConfigMapJSON,
  gitTokensSecretJSON,
  normalizeManifestPath,
  parseGitSources,
  redactURL,
  type GitSource,
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

/** Read all stored tokens, keyed by source name (decoded). Empty when absent. */
async function loadTokens(context: string | null): Promise<Record<string, string>> {
  const res = await kubectl(context, ["get", "secret", GIT_TOKENS_SECRET, "-n", STATE_NAMESPACE, "-o", "json"]);
  if (res.code !== 0) return {};
  try {
    const secret = JSON.parse(res.stdout) as { data?: Record<string, string> };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(secret.data ?? {})) out[k] = Buffer.from(v, "base64").toString("utf8");
    return out;
  } catch {
    return {};
  }
}

/** Read one source's token, or null. */
export async function loadToken(context: string | null, name: string): Promise<string | null> {
  const tokens = await loadTokens(context);
  return tokens[name] ?? null;
}

/** Set (or clear, when token is null) a source's token via read-modify-write. */
export async function saveToken(context: string | null, name: string, token: string | null): Promise<RunResult> {
  const tokens = await loadTokens(context);
  if (token == null || token === "") delete tokens[name];
  else tokens[name] = token;
  return applyManifest(context, gitTokensSecretJSON(STATE_NAMESPACE, tokens));
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
 * Shallow-clone the source's branch fresh into /tmp and return the checked-out
 * directory + HEAD sha. The token is embedded only for the clone, then scrubbed
 * from the stored remote so it isn't left at rest in .git/config.
 */
export async function ensureCheckout(source: GitSource, token: string | null): Promise<CheckoutResult> {
  const dir = repoDir(source.name);
  const authed = buildAuthedCloneURL(source.repoURL, token);
  await rm(dir, { recursive: true, force: true });
  await mkdir(REPO_ROOT, { recursive: true });

  const clone = await runGit(["clone", "--depth", "1", "--single-branch", "--branch", source.branch, authed, dir]);
  if (clone.code !== 0) {
    return { ok: false, message: redactURL(clone.stderr || clone.stdout || "git clone failed") };
  }
  // Scrub the token from the persisted remote.
  await runGit(["-C", dir, "remote", "set-url", "origin", source.repoURL]);

  const head = await runGit(["-C", dir, "rev-parse", "HEAD"]);
  const sha = head.code === 0 ? head.stdout.trim() : undefined;
  return { ok: true, sha, dir, message: "ok" };
}

/** Absolute manifest directory for a checked-out source. */
function manifestDir(dir: string, source: GitSource): string {
  const path = normalizeManifestPath(source.path);
  return path === "." ? dir : `${dir}/${path}`;
}

export interface GitOpResult extends RunResult {
  sha?: string;
}

/**
 * Clone + `kubectl diff -f <dir> -R` (the pre-apply preview). kubectl diff exits
 * 1 when differences exist and 0 when none — both are success here; >1 is error.
 */
export async function diffSource(context: string | null, source: GitSource, token: string | null): Promise<GitOpResult> {
  const co = await ensureCheckout(source, token);
  if (!co.ok || !co.dir) return { code: 1, stdout: "", stderr: co.message };
  const res = await kubectl(context, ["diff", "-f", manifestDir(co.dir, source), "-R"]);
  // Normalize: diff-present (1) is not an error for our purposes.
  const code = res.code === 1 ? 0 : res.code;
  return { code, stdout: res.stdout, stderr: res.stderr, sha: co.sha };
}

/** Clone + `kubectl apply -f <dir> -R`. Returns the apply result + synced sha. */
export async function applySource(context: string | null, source: GitSource, token: string | null): Promise<GitOpResult> {
  const co = await ensureCheckout(source, token);
  if (!co.ok || !co.dir) return { code: 1, stdout: "", stderr: co.message };
  const res = await kubectl(context, ["apply", "-f", manifestDir(co.dir, source), "-R"]);
  return { ...res, sha: co.sha };
}
