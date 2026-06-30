import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { proposeRepoFix, type RepoFixInput, type RepoFixResult } from "@rigel/k8s/src/repoFix.js";
import type { FixSpec } from "./fixJob.js";

/**
 * The fix-runner: the standalone entrypoint baked into the agent image and run
 * by the one-shot `rigel-fix-<id>` Job (NOT the always-on agent). It holds the
 * GitHub token (mounted from the `rigel-github` Secret) but has ZERO cluster
 * RBAC — it NEVER calls kubectl or touches the cluster. It reads the fix spec
 * from the mounted ConfigMap, clones/commits/opens the PR via the shared
 * `@rigel/k8s` repoFix core, and reports its result as a small JSON object on
 * the pod termination log (read back by the agent's Phase-4 reconcile).
 */

export interface FixRunResult {
  ok: boolean;
  prUrl?: string;
  branch?: string;
  message?: string;
}

/** Kubernetes caps the termination message at 4KiB; stay comfortably under it. */
const TERMINATION_MESSAGE_MAX_BYTES = 3500;

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Trim a string to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function truncateToBytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (byteLen(s) <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLen(s.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo);
}

/**
 * Serialize the run result to JSON for the termination log, truncating `message`
 * (the only unbounded field — a git/GitHub error) so the whole object stays under
 * the byte cap. ok/prUrl/branch are always preserved.
 */
export function serializeResult(r: FixRunResult, maxBytes = TERMINATION_MESSAGE_MAX_BYTES): string {
  const fixed: FixRunResult = { ok: r.ok };
  if (r.prUrl) fixed.prUrl = r.prUrl;
  if (r.branch) fixed.branch = r.branch;

  const message = r.message ?? "";
  const full = message ? { ...fixed, message } : fixed;
  const fullJSON = JSON.stringify(full);
  if (byteLen(fullJSON) <= maxBytes) return fullJSON;

  // Over budget → truncate the message to whatever room remains (with an ellipsis).
  const ELLIPSIS = "…";
  const overhead = byteLen(JSON.stringify({ ...fixed, message: "" }));
  const budget = maxBytes - overhead - byteLen(ELLIPSIS);
  const trimmed = truncateToBytes(message, budget) + ELLIPSIS;
  return JSON.stringify({ ...fixed, message: trimmed });
}

function requireStr(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`fix spec is missing required field: ${field}`);
  }
  return v;
}

/** Parse + validate the mounted fix spec. Throws on anything malformed so the
 *  runner fails closed (non-zero exit, error reported) rather than half-running. */
export function parseFixSpec(raw: string): FixSpec {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("fix spec is not valid JSON");
  }
  if (!obj || typeof obj !== "object") throw new Error("fix spec must be an object");
  const o = obj as Record<string, unknown>;
  const src = o.source;
  if (!src || typeof src !== "object") throw new Error("fix spec is missing required field: source");
  const s = src as Record<string, unknown>;
  const content = o.content;
  if (typeof content !== "string") throw new Error("fix spec is missing required field: content");
  return {
    source: {
      name: requireStr(s.name, "source.name"),
      repoURL: requireStr(s.repoURL, "source.repoURL"),
      branch: requireStr(s.branch, "source.branch"),
      path: typeof s.path === "string" ? s.path : ".",
    },
    filePath: requireStr(o.filePath, "filePath"),
    content,
    title: requireStr(o.title, "title"),
    body: typeof o.body === "string" ? o.body : undefined,
  };
}

export interface FixRunnerDeps {
  /** Read the raw fix-spec JSON (from the mounted ConfigMap file). */
  readSpec: () => Promise<string>;
  /** The GitHub token (from the mounted Secret), or null when absent. */
  getToken: () => string | null;
  /** Open the PR — the shared repoFix core; injected so it can be mocked. */
  propose: (input: RepoFixInput) => Promise<RepoFixResult>;
  /** Persist the JSON result to the termination log. */
  writeResult: (json: string) => Promise<void>;
}

/**
 * Orchestrate one fix: parse the spec, open the PR, report the result. Returns
 * the desired process exit code (0 on success, non-zero on failure). NEVER
 * touches the cluster. Failures (bad spec, missing token, git/GitHub error) are
 * captured into the reported result, not thrown out.
 */
export async function runFix(deps: FixRunnerDeps): Promise<number> {
  let spec: FixSpec;
  try {
    spec = parseFixSpec(await deps.readSpec());
  } catch (e) {
    await deps.writeResult(serializeResult({ ok: false, message: e instanceof Error ? e.message : String(e) }));
    return 1;
  }

  let result: RepoFixResult;
  try {
    result = await deps.propose({
      source: spec.source,
      token: deps.getToken(),
      filePath: spec.filePath,
      content: spec.content,
      title: spec.title,
      body: spec.body,
    });
  } catch (e) {
    await deps.writeResult(serializeResult({ ok: false, message: e instanceof Error ? e.message : String(e) }));
    return 1;
  }

  await deps.writeResult(
    serializeResult({ ok: result.ok, prUrl: result.prUrl, branch: result.branch, message: result.message }),
  );
  return result.ok ? 0 : 1;
}

async function main(): Promise<void> {
  const specPath = process.env.FIX_SPEC_PATH || "/etc/rigel-fix/spec.json";
  const terminationLog = process.env.TERMINATION_LOG || "/dev/termination-log";
  const code = await runFix({
    readSpec: () => readFile(specPath, "utf8"),
    getToken: () => process.env.GITHUB_TOKEN || null,
    propose: (input) => proposeRepoFix(input),
    // Best-effort: a failed termination-log write must not mask the real exit code.
    writeResult: async (json) => {
      try {
        await writeFile(terminationLog, json);
      } catch (e) {
        process.stderr.write(`fix-runner: could not write termination log: ${String(e)}\n`);
      }
      process.stdout.write(json + "\n");
    },
  });
  process.exit(code);
}

// Run only when executed directly (node dist/fixRunner.js), not when imported by
// tests. Realpath both sides so a symlinked launch path still matches (mirrors
// index.ts).
const entryArg = process.argv[1];
const entryPath = entryArg ? realpathSync(entryArg) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`fix-runner fatal: ${String(e)}\n`);
    process.exit(1);
  });
}
