# Cluster Assistant Multi-Provider — Plan 1: Agent Provider Abstraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the in-cluster Assistant's direct `runClaude()` calls with a single `runModel()` dispatch that reads each role's `{provider, model, effort}` from runtime config and routes to one of four per-provider CLI bridges (claude/codex/gemini/opencode), each enforcing read-only investigation via a guarded-kubectl shim + the CLI's auto-approve flag, normalizing output to one result shape, and failing closed on missing credentials / absent CLIs / malformed verdicts. Existing default-Claude behavior is unchanged and all existing tests stay green.

**Architecture:** The agent (`agent/`, package `rigel-assistant-agent`) is a standalone Node 22 + TypeScript app OUTSIDE the pnpm workspace (it has its own `package-lock.json` and uses **npm**, see `agent/Dockerfile` lines 11-13, 33-34; tests run via `npm test` → vitest). Plan 1 adds:
- `agent/src/guardedKubectl.ts` + `agent/src/commandPolicy.ts` — ported verbatim from `apps/server/src/{guardedKubectl,commandPolicy}.ts` (commandPolicy has zero imports; guardedKubectl depends only on commandPolicy + node builtins).
- `agent/src/providers/types.ts` — the shared `ProviderResult` + `ProviderBridge` interface + `RunModelInput`.
- `agent/src/providers/{claude,codex,gemini,opencode}.ts` — one bridge each (argv builder + output parser + auth env), mirroring `apps/server/src/{claudeBridge,codexBridge,geminiBridge,opencodeBridge}.ts`.
- `agent/src/runModel.ts` — role→provider dispatch returning `ProviderResult`.
- `agent/src/runtimeConfig.ts` — extended to parse per-role `{provider, model, effort}` + operational limits from the `assistant-config` ConfigMap, backward-compatible.
- `worker.ts` / `supervisor.ts` / `diagnose.ts` — refactored to call `runModel` instead of `runClaude`.
- `agent/src/selfCheck.ts` — startup self-check logging which provider CLIs are present.
- `agent/Dockerfile` — installs codex/gemini/opencode + the guarded-kubectl shim, runs the self-check.

**Tech Stack:** Node 22, TypeScript (ESM, `.js` import specifiers), vitest 4, npm (NOT pnpm — `agent/` is outside the workspace). Test command everywhere below: `npm --prefix agent test` (runs `vitest run`). The agent CLIs are spawned via `node:child_process` `spawn`; Claude returns a single JSON envelope (`--output-format json`), Gemini/Codex/OpenCode stream newline-delimited JSON (JSONL) — the bridges collect events and extract the final message.

> **NOTE for the human (not a code step):** `docs/` is gitignored in this repo. This plan file will not be tracked by `git add`; if you want it committed, use `git add -f docs/superpowers/plans/2026-06-22-assistant-multi-provider-1-agent-core.md`.

---

## Task 1 — Port `commandPolicy.ts` into `agent/`

The guarded-kubectl shim needs the denylist policy. It is self-contained (zero imports), so port it verbatim. The agent's policy intent is identical: reads allowed, cluster mutations denied (the agent must not mutate during investigation, even though its RBAC CAN patch/delete in the deterministic execution phase).

**Files:**
- Create: `agent/src/commandPolicy.ts` (port of `apps/server/src/commandPolicy.ts`, 172 lines)
- Create (test): `agent/src/commandPolicy.test.ts`

**Steps:**

- [ ] Write the failing test `agent/src/commandPolicy.test.ts`:
```ts
import { describe, expect, test } from "vitest";
import { classifyCommand } from "./commandPolicy.js";

describe("classifyCommand (agent port)", () => {
  test("plain reads are allowed", () => {
    expect(classifyCommand("kubectl get pods").decision).toBe("allow");
    expect(classifyCommand("kubectl rollout status deploy/x").decision).toBe("allow");
    expect(classifyCommand("kubectl auth can-i get pods").decision).toBe("allow");
  });

  test("cluster mutations are denied with the action-block hint", () => {
    const v = classifyCommand("kubectl delete pod x");
    expect(v.decision).toBe("deny");
    expect(v.reason).toMatch(/action block/i);
  });

  test("helm mutations are denied", () => {
    expect(classifyCommand("helm install affine ./chart").decision).toBe("deny");
  });

  test("a mutation hidden in a chain or wrapper is still denied", () => {
    expect(classifyCommand("kubectl get pods && kubectl delete pod x").decision).toBe("deny");
    expect(classifyCommand(`sh -c "kubectl delete pod x"`).decision).toBe("deny");
    expect(classifyCommand("xargs kubectl delete pod").decision).toBe("deny");
  });

  test("port-forward / proxy are blocked (cannot run headless)", () => {
    const v = classifyCommand("kubectl port-forward svc/x 8080:80");
    expect(v.decision).toBe("deny");
    expect(v.reason).toMatch(/port-forward/i);
  });

  test("namespace value flag does not get mistaken for the verb", () => {
    expect(classifyCommand("kubectl -n personal get pods").decision).toBe("allow");
  });
});
```

- [ ] Run it, expect FAIL (module not found): `npm --prefix agent test -- commandPolicy`

- [ ] Create `agent/src/commandPolicy.ts` by copying `apps/server/src/commandPolicy.ts` verbatim (it has no imports and uses no `.js` specifiers, so it ports unchanged). The full file content:
```ts
// Denylist permission policy for the agent's read-only investigation.
//
// The agent investigates freely (reads) but must NEVER mutate during
// investigation, so we DENYLIST: anything that isn't a cluster MUTATION is
// auto-allowed; kubectl/helm verbs that change cluster state are denied (the
// deterministic execution phase, not the model, performs approved mutations).
//
// Security note: false positives (denying a read) just cost an investigation
// step; false NEGATIVES (allowing a mutation) are the danger, so verb detection
// skips global flags+values precisely, and unknown shapes bias toward "allow"
// only for non kubectl/helm commands. kubectl/helm verbs are matched against sets.

/** kubectl verbs that change cluster (or pod) state → denied. */
const KUBECTL_MUTATING = new Set([
  "apply", "create", "delete", "patch", "edit", "replace", "scale",
  "annotate", "label", "set", "expose", "autoscale", "run", "apply",
  "cordon", "uncordon", "drain", "taint", "exec", "cp", "attach", "debug",
  "rollout", "auth", // refined below: rollout status/history & auth can-i are reads
  "certificate", "approve", "deny", "evict", "delete-context",
]);

/** `rollout`/`auth` subcommands that are READ-ONLY (so not every rollout/auth denies). */
const READONLY_SUBCOMMANDS: Record<string, Set<string>> = {
  rollout: new Set(["status", "history"]),
  auth: new Set(["can-i", "whoami"]),
};

/**
 * kubectl verbs that don't mutate but can't run headless — they block forever
 * with no terminal. Denied with a "blocked" reason rather than the action reason.
 */
const KUBECTL_BLOCKED = new Set(["port-forward", "proxy"]);

/** helm verbs that change cluster state → denied. */
const HELM_MUTATING = new Set([
  "install", "upgrade", "uninstall", "delete", "rollback",
]);

/**
 * kubectl/helm GLOBAL flags that consume the NEXT token as their value (when not
 * written as `--flag=value`). We must skip both so the value isn't mistaken for
 * the verb (e.g. `kubectl -n personal get` → skip `-n personal`, verb = `get`).
 */
const VALUE_FLAGS = new Set([
  "--context", "--namespace", "-n", "--kubeconfig", "--cluster", "--user",
  "--as", "--as-group", "--as-uid", "--token", "-s", "--server",
  "--tls-server-name", "--certificate-authority", "--client-certificate",
  "--client-key", "--request-timeout", "--cache-dir", "-o", "--output",
  "--chunk-size", "--profile", "--profile-output", "--log-flush-frequency",
  // helm connection flags
  "--kube-context", "--kube-apiserver", "--kube-token", "--kube-as-user",
  "--kube-as-group", "--kube-ca-file", "--registry-config",
  "--repository-config", "--repository-cache", "--burst-limit",
]);

export interface CommandVerdict {
  decision: "allow" | "deny";
  /** Why — for deny, this is fed back to the model to steer it away from mutating. */
  reason: string;
}

const APPROVAL_HINT =
  "This changes the cluster, so it can't run during investigation. Do NOT retry it via Bash. " +
  "If a fix is warranted, describe it in prose / emit a single ```action block so it can be " +
  "queued for approval — never run a mutating kubectl/helm command yourself.";

const BLOCKED_HINT =
  "kubectl port-forward / proxy can't run here — they block with no terminal. Do NOT retry it.";

/** First non-flag token after the binary = the verb. Skips global flags + values. */
function findVerb(tokens: string[]): { verb: string | null; sub: string | null } {
  let i = 0;
  let verb: string | null = null;
  for (; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith("-")) {
      if (VALUE_FLAGS.has(t)) i++; // skip the flag's space-separated value
      continue; // `--flag=value`, bare `-`, or boolean flag
    }
    verb = t;
    break;
  }
  // the next non-flag token after the verb (sub-command, e.g. `rollout status`)
  let sub: string | null = null;
  for (let j = i + 1; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.startsWith("-")) {
      if (VALUE_FLAGS.has(t)) j++;
      continue;
    }
    sub = t;
    break;
  }
  return { verb, sub };
}

/** Drop surrounding quotes so `sh -c "kubectl delete …"` tokens compare cleanly. */
function unquote(t: string): string {
  return t.replace(/^['"]+/, "").replace(/['"]+$/, "");
}

/** What a kubectl invocation (tokens after the binary) amounts to. */
type Category = "mutation" | "blocked" | null;

function kubectlCategory(rest: string[]): Category {
  const { verb, sub } = findVerb(rest);
  if (!verb) return null;
  if (KUBECTL_MUTATING.has(verb)) {
    const readSubs = READONLY_SUBCOMMANDS[verb];
    if (readSubs && sub && readSubs.has(sub)) return null;
    return "mutation";
  }
  if (KUBECTL_BLOCKED.has(verb)) return "blocked";
  return null;
}

/**
 * Categorize one pipeline/chain segment. Scans for `kubectl`/`k`/`helm` at ANY
 * token position (after quote-stripping), so wrappers like `xargs kubectl delete`,
 * `sh -c "kubectl delete …"`, `watch`/`timeout`/`env` are caught. "mutation"
 * outranks "blocked".
 */
function segmentCategory(segment: string): Category {
  const tokens = segment.trim().split(/\s+/).filter(Boolean).map(unquote);
  let blocked = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "kubectl" || t === "k") {
      const c = kubectlCategory(tokens.slice(i + 1));
      if (c === "mutation") return "mutation";
      if (c === "blocked") blocked = true;
    } else if (t === "helm") {
      const { verb } = findVerb(tokens.slice(i + 1));
      if (verb != null && HELM_MUTATING.has(verb)) return "mutation";
    }
  }
  return blocked ? "blocked" : null;
}

/**
 * Classify a Bash command. Splits on shell separators (; && || | and newlines)
 * and treats the command as a mutation if ANY segment is one. A `$(...)`/backtick
 * substitution that hides a kubectl/helm mutation is caught by a coarse backstop.
 */
export function classifyCommand(command: string): CommandVerdict {
  let blocked = false;
  const scan = (text: string) => {
    for (const seg of text.split(/;|&&|\|\||\||\n/)) {
      const c = segmentCategory(seg);
      if (c === "mutation") return "mutation" as const;
      if (c === "blocked") blocked = true;
    }
    return null;
  };

  if (scan(command) === "mutation") return { decision: "deny", reason: APPROVAL_HINT };
  if (/[`$]\(?/.test(command)) {
    const inner = command.match(/\$\(([^)]*)\)|`([^`]*)`/g) ?? [];
    for (const m of inner) {
      const body = m.replace(/^\$\(|^`|\)$|`$/g, "");
      if (scan(body) === "mutation") return { decision: "deny", reason: APPROVAL_HINT };
    }
  }
  if (blocked) return { decision: "deny", reason: BLOCKED_HINT };
  return { decision: "allow", reason: "non-mutating — read/investigation command" };
}
```

- [ ] Run it, expect PASS: `npm --prefix agent test -- commandPolicy`

- [ ] Commit:
```
git add agent/src/commandPolicy.ts agent/src/commandPolicy.test.ts
git commit -m "feat(agent): port commandPolicy denylist into the agent"
```

---

## Task 2 — Port the guarded-kubectl shim into `agent/`

Mirror `apps/server/src/guardedKubectl.ts` (`runGuard`, `guardVerdict`, `provisionGuardBin`, `wrapperScript`). The only adaptation: the runner-command env override is renamed `RIGEL_AGENT_GUARD_CMD` (so it can't clash with the chat's `RIGEL_GUARD_CMD`), and the entry resolves to `./guardedKubectl.js` (compiled) — the dev/test path runs the `.ts` via `tsx` exactly like the chat does.

**Files:**
- Create: `agent/src/guardedKubectl.ts` (port of `apps/server/src/guardedKubectl.ts`)
- Create (test): `agent/src/guardedKubectl.test.ts`

**Steps:**

- [ ] Write the failing test `agent/src/guardedKubectl.test.ts`:
```ts
import { test, expect, describe } from "vitest";
import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { guardVerdict, runGuard, provisionGuardBin, wrapperScript } from "./guardedKubectl.js";

const GUARD_ENTRY = fileURLToPath(new URL("./guardedKubectl.ts", import.meta.url));

function runEntry(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", ["--import", "tsx", GUARD_ENTRY, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe("guardVerdict — pure policy decisions", () => {
  test("plain reads are allowed", () => {
    expect(guardVerdict("kubectl", ["get", "pods"]).decision).toBe("allow");
  });
  test("cluster mutations are denied", () => {
    expect(guardVerdict("kubectl", ["delete", "pod", "x"]).decision).toBe("deny");
  });
  test("helm mutations are denied", () => {
    expect(guardVerdict("helm", ["install", "x", "./c"]).decision).toBe("deny");
  });
});

describe("runGuard — dispatch (fake real binary = /bin/echo, never a cluster)", () => {
  test("allowed read execs the real binary and forwards exit 0", async () => {
    const r = await runEntry(["kubectl", "/bin/echo", "get", "pods"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("get pods");
  });
  test("denied mutation does NOT exec the real binary; stderr carries the reason", async () => {
    const r = await runEntry(["kubectl", "/bin/echo", "delete", "pod", "x"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/action block|cluster/i);
    expect(r.stdout).not.toContain("delete");
  });
  test("runGuard rejects malformed argv", async () => {
    expect(await runGuard(["kubectl"])).toBe(2);
  });
});

describe("provisionGuardBin — materializes executable wrappers", () => {
  test("writes an executable kubectl wrapper referencing the real binary + guard entry", async () => {
    const dir = await provisionGuardBin();
    const entries = await readdir(dir);
    expect(entries).toContain("kubectl");
    const info = await stat(join(dir, "kubectl"));
    expect(info.mode & 0o111).not.toBe(0);
    const text = await readFile(join(dir, "kubectl"), "utf8");
    expect(text).toContain("guardedKubectl");
    expect(text).toMatch(/exec .*'kubectl' '\/.*kubectl' "\$@"/);
  });
});

describe("wrapperScript", () => {
  const runner = `node --import tsx '${GUARD_ENTRY}'`;
  test("single-quotes logicalName + realBinaryPath", () => {
    const text = wrapperScript(runner, "kubectl", "/usr/local/bin/kubectl");
    expect(text).toContain(`'kubectl' '/usr/local/bin/kubectl'`);
    expect(text).toMatch(/"\$@"\s*$/m);
  });
});
```

- [ ] Run it, expect FAIL (module not found): `npm --prefix agent test -- guardedKubectl`

- [ ] Create `agent/src/guardedKubectl.ts`:
```ts
#!/usr/bin/env node
// Portable "guarded kubectl/helm" shim for the agent's non-Claude provider
// bridges. Claude enforces read-only with --allowedTools; the other CLIs have no
// such hook, so we enforce the SAME policy by placing wrapper scripts named
// `kubectl`/`helm` FIRST on the provider subprocess's PATH (see provisionGuardBin).
// Every kubectl/helm the model — or any child like `sh -c …` — execs resolves to
// this shim, which classifies via commandPolicy.classifyCommand: reads run against
// the real binary, cluster MUTATIONS are denied. Ported from apps/server.
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyCommand, type CommandVerdict } from "./commandPolicy.js";

/** Pure decision core: reconstruct `[logicalName, ...userArgs]` and defer to policy. */
export function guardVerdict(logicalName: string, userArgs: string[]): CommandVerdict {
  return classifyCommand([logicalName, ...userArgs].join(" "));
}

/**
 * Shim entry. argv layout = `[logicalName, realBinaryPath, ...userArgs]`.
 * Allowed reads exec the real binary (stdio inherited, exit code forwarded);
 * denied mutations write the reason to stderr and exit 1 WITHOUT running anything.
 */
export function runGuard(argv: string[]): Promise<number> {
  const [logicalName, realBinaryPath, ...userArgs] = argv;
  if (!logicalName || !realBinaryPath) {
    process.stderr.write("guarded-kubectl: usage: <logicalName> <realBinaryPath> [args…]\n");
    return Promise.resolve(2);
  }
  const verdict = guardVerdict(logicalName, userArgs);
  if (verdict.decision === "deny") {
    process.stderr.write(verdict.reason + "\n");
    return Promise.resolve(1);
  }
  return new Promise<number>((resolve) => {
    const child = spawn(realBinaryPath, userArgs, { stdio: "inherit" });
    child.on("error", (err) => {
      process.stderr.write(`guarded-kubectl: failed to exec ${realBinaryPath}: ${err.message}\n`);
      resolve(127);
    });
    child.on("exit", (code, signal) => {
      if (signal) resolve(128 + (osSignalNumber(signal) ?? 0));
      else resolve(code ?? 0);
    });
  });
}

/** POSIX signal name → number for the 128+n exit convention (best-effort). */
function osSignalNumber(signal: NodeJS.Signals): number | undefined {
  const table: Partial<Record<NodeJS.Signals, number>> = {
    SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15,
  };
  return table[signal];
}

/**
 * The command that runs the guard entry. Dev/test default: run this .ts via Node +
 * tsx, resolved next to this module. In the built image, RIGEL_AGENT_GUARD_CMD can
 * override to run the compiled `.js` directly (e.g. `node /app/dist/guardedKubectl.js`).
 */
function guardRunnerCommand(): string {
  const entry = fileURLToPath(new URL("./guardedKubectl.ts", import.meta.url));
  return process.env.RIGEL_AGENT_GUARD_CMD || `node --import tsx '${entry}'`;
}

/** Resolve the real absolute path of a binary on the CURRENT PATH (no shim yet). */
async function whichBinary(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", `command -v ${name}`], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(null));
    child.on("exit", (code) => resolve(code === 0 && out.trim() ? out.trim() : null));
  });
}

/** One wrapper script: exec the guard entry with (logicalName, realBinaryPath, "$@"). */
export function wrapperScript(runner: string, logicalName: string, realBinaryPath: string): string {
  return `#!/bin/sh
# Auto-generated guarded shim for \`${logicalName}\` — routes through the agent's
# command policy (agent/src/guardedKubectl.ts). Reads run; cluster mutations denied.
exec ${runner} '${logicalName}' '${realBinaryPath}' "$@"
`;
}

/**
 * Materialize the guarded shim dir. Writes executable `kubectl` (and `helm` if
 * installed) wrappers into a fresh OS-temp dir. The provider bridges prepend the
 * returned dir to their subprocess PATH. Throws if kubectl can't be found.
 */
export async function provisionGuardBin(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rigel-agent-guard-"));
  const runner = guardRunnerCommand();

  const kubectlReal = await whichBinary("kubectl");
  if (!kubectlReal) {
    throw new Error("guarded-kubectl: `kubectl` was not found on PATH — cannot provision the guarded shim.");
  }
  await writeWrapper(dir, runner, "kubectl", kubectlReal);

  const helmReal = await whichBinary("helm");
  if (helmReal) await writeWrapper(dir, runner, "helm", helmReal);

  return dir;
}

async function writeWrapper(
  dir: string,
  runner: string,
  logicalName: string,
  realBinaryPath: string,
): Promise<void> {
  const p = join(dir, logicalName);
  await writeFile(p, wrapperScript(runner, logicalName, realBinaryPath));
  await chmod(p, 0o755);
}

// Run as the shim only when executed directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runGuard(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`guarded-kubectl: ${err?.message ?? err}\n`);
      process.exit(1);
    },
  );
}
```

- [ ] Run it, expect PASS: `npm --prefix agent test -- guardedKubectl`

- [ ] Commit:
```
git add agent/src/guardedKubectl.ts agent/src/guardedKubectl.test.ts
git commit -m "feat(agent): port guarded-kubectl shim (provisionGuardBin/runGuard)"
```

---

## Task 3 — Define the shared bridge interface and result types

This is the contract every bridge and `runModel` agree on. `ProviderResult` is a superset of the existing `ClaudeResult` (`agent/src/claude.ts` lines 10-18) so the refactored worker/supervisor/diagnose keep reading `.text`, `.structuredOutput`, `.sessionId`, `.isError`, `.costUsd`. It adds `errorMessage` for fail-close diagnostics.

**Files:**
- Create: `agent/src/providers/types.ts`
- Create (test): `agent/src/providers/types.test.ts`

**Steps:**

- [ ] Write the failing test `agent/src/providers/types.test.ts`:
```ts
import { describe, expect, test } from "vitest";
import { errorResult, type ProviderResult } from "./types.js";

describe("errorResult", () => {
  test("builds a fail-closed result carrying the message", () => {
    const r: ProviderResult = errorResult("no GEMINI_API_KEY in env");
    expect(r.isError).toBe(true);
    expect(r.errorMessage).toBe("no GEMINI_API_KEY in env");
    expect(r.text).toBe("");
    expect(r.costUsd).toBe(0);
    expect(r.structuredOutput).toBeUndefined();
    expect(r.sessionId).toBeUndefined();
  });
});
```

- [ ] Run it, expect FAIL: `npm --prefix agent test -- providers/types`

- [ ] Create `agent/src/providers/types.ts`:
```ts
import type { CommandVerdict } from "../commandPolicy.js";

export type { CommandVerdict };

/** The provider this role uses. Mirrors the chat's AgentId. */
export type ProviderId = "claude" | "codex" | "gemini" | "opencode";

/** Which role we are running the model for. */
export type Role = "worker" | "supervisor";

/** Per-role selection, parsed from the assistant-config ConfigMap. */
export interface RoleSelection {
  provider: ProviderId;
  model: string;
  /** Claude-family only; ignored by other providers. */
  effort?: string;
}

/**
 * The single normalized result EVERY bridge returns and runModel passes back.
 * Superset of the legacy ClaudeResult so worker/supervisor/diagnose keep working.
 * A bridge NEVER throws for an expected failure (missing cred, absent CLI, bad
 * exit, malformed structured output) — it returns { isError: true, errorMessage }
 * so the caller fails closed deterministically.
 */
export interface ProviderResult {
  /** Final assistant prose. "" on error. */
  text: string;
  /** USD cost when the CLI reports it (Claude only today); 0 otherwise. */
  costUsd: number;
  /** True if the call failed OR the provider returned an error result. */
  isError: boolean;
  /** Human-readable failure detail when isError; undefined on success. */
  errorMessage?: string;
  /** CLI session id to resume the thread (Claude only); undefined otherwise. */
  sessionId?: string;
  /** Validated/parsed structured output when a structuredSchema was requested. */
  structuredOutput?: unknown;
}

/** Input to a single model turn — provider-agnostic. */
export interface RunModelInput {
  /** Final model id to launch (already resolved from the role selection). */
  model: string;
  /** The user/task prompt. */
  prompt: string;
  /** Appended system prompt / instructions. */
  systemPrompt?: string;
  /** Read-only kubectl allowlist for the Claude bridge's --allowedTools. The
   *  other bridges enforce read-only via the guarded-kubectl shim instead. */
  allowedReads?: string[];
  /** When set, request structured JSON matching this JSON-Schema string. */
  structuredSchema?: string;
  /** Claude-family reasoning effort; ignored by other providers. */
  effort?: string;
  /** Prior CLI session id (Claude resumes; others run fresh per turn). */
  resumeSessionId?: string;
  /** Abort the in-flight subprocess. */
  signal?: AbortSignal;
  /** Per-turn wall-clock cap in ms. */
  timeoutMs?: number;
}

/**
 * One provider bridge. `authEnv()` returns the env vars that authenticate this
 * provider, or null when no credential is present (→ runModel fails closed with a
 * clear "add a key" message). `run()` performs one turn and ALWAYS resolves to a
 * ProviderResult (never throws for expected failures).
 */
export interface ProviderBridge {
  id: ProviderId;
  /** Env vars from process.env to authenticate, or null if no credential set. */
  authEnv(): Record<string, string> | null;
  /** Run one turn. Resolves (never rejects) to a normalized result. */
  run(input: RunModelInput): Promise<ProviderResult>;
}

/** Build a fail-closed error result carrying a message. */
export function errorResult(message: string): ProviderResult {
  return { text: "", costUsd: 0, isError: true, errorMessage: message };
}
```

- [ ] Run it, expect PASS: `npm --prefix agent test -- providers/types`

- [ ] Commit:
```
git add agent/src/providers/types.ts agent/src/providers/types.test.ts
git commit -m "feat(agent): shared ProviderBridge interface + ProviderResult types"
```

---

## Task 4 — Shared JSONL streaming harness for non-Claude bridges

Codex/Gemini/OpenCode stream newline-delimited JSON. Mirror `apps/server/src/agentProcess.ts` `streamAgentProcess`, but reduced to what the agent needs: spawn, read JSONL, map each line to events, collect, return on exit/abort. Unlike the chat (which yields a live generator), the agent only needs the FINAL collected message + session id + error, so this harness returns a `CollectedRun` object.

**Files:**
- Create: `agent/src/providers/process.ts`
- Create (test): `agent/src/providers/process.test.ts`

**Steps:**

- [ ] Write the failing test `agent/src/providers/process.test.ts`:
```ts
import { test, expect, describe } from "vitest";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { collectJsonlRun, type CollectedEvent } from "./process.js";

/** A fake CLI on PATH that prints the given lines then exits with `code`. */
async function fakeCli(name: string, lines: string[], code = 0): Promise<{ dir: string; restore: () => void }> {
  const dir = await mkdtemp(join(tmpdir(), `rigel-fake-${name}-`));
  const bin = join(dir, name);
  await writeFile(bin, ["#!/bin/sh", ...lines.map((l) => `echo '${l}'`), `exit ${code}`].join("\n") + "\n");
  await chmod(bin, 0o755);
  const prev = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${prev ?? ""}`;
  return { dir, restore: () => { process.env.PATH = prev; } };
}

/** Trivial mapper: {kind:"text",text} → text event; {kind:"err",text} → error. */
function mapEvent(ev: any): CollectedEvent[] {
  if (ev?.kind === "text") return [{ type: "text", text: ev.text }];
  if (ev?.kind === "session") return [{ type: "session", sessionId: ev.id }];
  if (ev?.kind === "err") return [{ type: "error", text: ev.text }];
  return [];
}

describe("collectJsonlRun", () => {
  test("collects final text + session, no error, on clean exit", async () => {
    const f = await fakeCli("fakecli", [
      `{"kind":"session","id":"s1"}`,
      `{"kind":"text","text":"part one. "}`,
      `{"kind":"text","text":"part two."}`,
    ]);
    try {
      const r = await collectJsonlRun({ argv: ["fakecli"], env: process.env as Record<string, string>, mapEvent });
      expect(r.text).toBe("part one. part two.");
      expect(r.sessionId).toBe("s1");
      expect(r.isError).toBe(false);
    } finally { f.restore(); await rm(f.dir, { recursive: true, force: true }); }
  });

  test("a mapped error event makes the run an error", async () => {
    const f = await fakeCli("fakecli2", [`{"kind":"err","text":"boom"}`]);
    try {
      const r = await collectJsonlRun({ argv: ["fakecli2"], env: process.env as Record<string, string>, mapEvent });
      expect(r.isError).toBe(true);
      expect(r.errorText).toBe("boom");
    } finally { f.restore(); await rm(f.dir, { recursive: true, force: true }); }
  });

  test("a non-zero exit with no error event surfaces stderr/exit as the error", async () => {
    const f = await fakeCli("fakecli3", [`{"kind":"text","text":"hi"}`], 7);
    try {
      const r = await collectJsonlRun({ argv: ["fakecli3"], env: process.env as Record<string, string>, mapEvent });
      expect(r.isError).toBe(true);
      expect(r.errorText).toMatch(/exited with code 7|code 7/);
    } finally { f.restore(); await rm(f.dir, { recursive: true, force: true }); }
  });

  test("ENOENT (binary not found) is reported as an error, not a throw", async () => {
    const r = await collectJsonlRun({ argv: ["definitely-not-a-real-binary-xyz"], env: process.env as Record<string, string>, mapEvent });
    expect(r.isError).toBe(true);
    expect(r.errorText).toMatch(/ENOENT|not be found/i);
  });
});
```

- [ ] Run it, expect FAIL: `npm --prefix agent test -- providers/process`

- [ ] Create `agent/src/providers/process.ts`:
```ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** One mapped event from a CLI JSONL line. */
export interface CollectedEvent {
  type: "text" | "thinking" | "session" | "error" | "done";
  text?: string;
  sessionId?: string;
}

export interface CollectJsonlArgs {
  /** Full argv; argv[0] is the binary. */
  argv: string[];
  env: Record<string, string>;
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Map ONE parsed JSONL object to zero+ CollectedEvents. */
  mapEvent: (ev: any) => CollectedEvent[];
}

/** The collected outcome of one streamed CLI run. */
export interface CollectedRun {
  /** Concatenated text events (the final assistant message). */
  text: string;
  /** Last session id seen (for resume, when the CLI emits one). */
  sessionId?: string;
  isError: boolean;
  /** Failure detail when isError. */
  errorText?: string;
}

/**
 * Spawn a CLI, read newline-delimited JSON from stdout, map each line via
 * mapEvent, and COLLECT the final text + session id. Mirrors the chat's
 * streamAgentProcess (apps/server/src/agentProcess.ts) but returns the collected
 * result instead of yielding live events — the agent only needs the final message.
 * NEVER rejects for an expected failure (ENOENT, non-zero exit, mapped error): all
 * surface as { isError: true, errorText } so callers fail closed.
 */
export async function collectJsonlRun({
  argv,
  env,
  cwd,
  signal,
  timeoutMs,
  mapEvent,
}: CollectJsonlArgs): Promise<CollectedRun> {
  const proc = spawn(argv[0]!, argv.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    ...(cwd ? { cwd } : {}),
  });

  const stderrChunks: Buffer[] = [];
  proc.stderr!.on("data", (b: Buffer) => stderrChunks.push(b));

  let textOut = "";
  let sessionId: string | undefined;
  let mappedError: string | undefined;

  const timer = timeoutMs
    ? setTimeout(() => {
        try {
          proc.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      }, timeoutMs)
    : undefined;

  const onAbort = () => {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  const exitPromise: Promise<number | null> = new Promise((resolve) => {
    proc.once("close", (code) => resolve(code));
    proc.once("error", (err: Error) => {
      stderrChunks.push(Buffer.from(err.message));
      resolve(-1);
    });
  });

  const rl = createInterface({ input: proc.stdout! });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    for (const e of mapEvent(ev)) {
      if (e.type === "text" && typeof e.text === "string") textOut += e.text;
      else if (e.type === "session" && typeof e.sessionId === "string") sessionId = e.sessionId;
      else if (e.type === "error" && typeof e.text === "string" && !mappedError) mappedError = e.text;
    }
  }

  const exitCode = await exitPromise;
  if (timer) clearTimeout(timer);
  if (signal) signal.removeEventListener("abort", onAbort);

  if (signal?.aborted) {
    return { text: textOut, sessionId, isError: true, errorText: "aborted" };
  }
  if (mappedError) {
    return { text: textOut, sessionId, isError: true, errorText: mappedError };
  }
  if (exitCode !== 0) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    return {
      text: textOut,
      sessionId,
      isError: true,
      errorText: formatProcessError(argv[0]!, stderr, exitCode),
    };
  }
  return { text: textOut, sessionId, isError: false };
}

/** Concise failure text — mirrors agentProcess.formatProcessError. */
function formatProcessError(binary: string, stderr: string, exitCode: number | null): string {
  const text = stderr.trim();
  if (/\bENOENT\b/.test(text)) {
    return `The "${binary}" CLI could not be found (ENOENT). Make sure it is installed in the image.`;
  }
  if (!text) return `${binary} exited with code ${exitCode}`;
  return text.length > 600 ? text.slice(0, 600) + "…" : text;
}
```

- [ ] Run it, expect PASS: `npm --prefix agent test -- providers/process`

- [ ] Commit:
```
git add agent/src/providers/process.ts agent/src/providers/process.test.ts
git commit -m "feat(agent): JSONL collect harness for non-Claude bridges"
```

---

## Task 5 — Claude bridge (wraps the existing `runClaude`)

The Claude bridge reuses `runClaude` (`agent/src/claude.ts`) unchanged — no rewrite of the working path. It adapts the new `RunModelInput`/`ProviderResult` contract onto it, maps `allowedReads → allowedTools`, `structuredSchema → jsonSchema`, `resumeSessionId → resumeSessionId`, and converts a thrown `runClaude` error into a fail-closed `ProviderResult` (so the dispatcher uses one error convention across all providers). Auth env: present iff `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` is set.

**Files:**
- Create: `agent/src/providers/claude.ts`
- Create (test): `agent/src/providers/claude.test.ts`
- (Read-only reference: `agent/src/claude.ts`)

**Steps:**

- [ ] Write the failing test `agent/src/providers/claude.test.ts`:
```ts
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { claudeBridge } from "./claude.js";
import * as claudeMod from "../claude.js";

describe("claudeBridge.authEnv", () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.CLAUDE_CODE_OAUTH_TOKEN; delete process.env.ANTHROPIC_API_KEY; });
  afterEach(() => { process.env = { ...saved }; });

  test("null when no credential is present", () => {
    expect(claudeBridge.authEnv()).toBeNull();
  });
  test("returns the OAuth token env when present", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "tok-123";
    expect(claudeBridge.authEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "tok-123" });
  });
  test("returns the API key env when only that is present", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-1";
    expect(claudeBridge.authEnv()).toEqual({ ANTHROPIC_API_KEY: "sk-ant-1" });
  });
});

describe("claudeBridge.run", () => {
  afterEach(() => vi.restoreAllMocks());

  test("maps a successful runClaude result onto ProviderResult", async () => {
    vi.spyOn(claudeMod, "runClaude").mockResolvedValue({
      text: "all good", costUsd: 0.02, isError: false, sessionId: "sess-1",
      structuredOutput: { decision: "approve", confidence: 0.9, reason: "ok" },
    });
    const r = await claudeBridge.run({
      model: "claude-opus-4-8", prompt: "check", systemPrompt: "sys",
      allowedReads: ["Bash(kubectl get *)"], structuredSchema: "{}", resumeSessionId: "prev",
    });
    expect(r.isError).toBe(false);
    expect(r.text).toBe("all good");
    expect(r.costUsd).toBe(0.02);
    expect(r.sessionId).toBe("sess-1");
    expect(r.structuredOutput).toEqual({ decision: "approve", confidence: 0.9, reason: "ok" });
  });

  test("forwards model/allowedTools/jsonSchema/resume to runClaude", async () => {
    const spy = vi.spyOn(claudeMod, "runClaude").mockResolvedValue({ text: "x", costUsd: 0, isError: false });
    await claudeBridge.run({
      model: "claude-sonnet-4-6", prompt: "p", systemPrompt: "s",
      allowedReads: ["Bash(kubectl get *)"], structuredSchema: "SCHEMA", resumeSessionId: "r1", timeoutMs: 1234,
    });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      model: "claude-sonnet-4-6", prompt: "p", appendSystemPrompt: "s",
      allowedTools: ["Bash(kubectl get *)"], jsonSchema: "SCHEMA", resumeSessionId: "r1", timeoutMs: 1234,
    }));
  });

  test("a thrown runClaude error becomes a fail-closed ProviderResult (no throw)", async () => {
    vi.spyOn(claudeMod, "runClaude").mockRejectedValue(new Error("claude exited 1: 401 unauthorized"));
    const r = await claudeBridge.run({ model: "claude-opus-4-8", prompt: "x" });
    expect(r.isError).toBe(true);
    expect(r.errorMessage).toMatch(/401 unauthorized/);
    expect(r.text).toBe("");
  });
});
```

- [ ] Run it, expect FAIL: `npm --prefix agent test -- providers/claude`

- [ ] Create `agent/src/providers/claude.ts`:
```ts
import { runClaude } from "../claude.js";
import { errorResult, type ProviderBridge, type ProviderResult, type RunModelInput } from "./types.js";

/**
 * Claude bridge — wraps the existing, working `runClaude` (agent/src/claude.ts).
 * Read-only investigation stays enforced with --allowedTools; structured verdicts
 * use --json-schema; sessions resume via --resume. Auth is the subscription token
 * (CLAUDE_CODE_OAUTH_TOKEN) or ANTHROPIC_API_KEY, injected by the Deployment env.
 */
export const claudeBridge: ProviderBridge = {
  id: "claude",

  authEnv(): Record<string, string> | null {
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (token && token.trim()) return { CLAUDE_CODE_OAUTH_TOKEN: token };
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey && apiKey.trim()) return { ANTHROPIC_API_KEY: apiKey };
    return null;
  },

  async run(input: RunModelInput): Promise<ProviderResult> {
    try {
      const r = await runClaude({
        model: input.model,
        prompt: input.prompt,
        appendSystemPrompt: input.systemPrompt,
        allowedTools: input.allowedReads,
        jsonSchema: input.structuredSchema,
        resumeSessionId: input.resumeSessionId,
        timeoutMs: input.timeoutMs,
      });
      return {
        text: r.text,
        costUsd: r.costUsd,
        isError: r.isError,
        sessionId: r.sessionId,
        structuredOutput: r.structuredOutput,
      };
    } catch (e) {
      return errorResult(String(e instanceof Error ? e.message : e));
    }
  },
};
```

- [ ] Run it, expect PASS: `npm --prefix agent test -- providers/claude`

- [ ] Commit:
```
git add agent/src/providers/claude.ts agent/src/providers/claude.test.ts
git commit -m "feat(agent): claude bridge wrapping runClaude onto the bridge contract"
```

---

## Task 6 — Structured-output normalizer (shared by non-Claude bridges)

Non-Claude providers have no `--json-schema`. The supervisor verdict path needs strict JSON. This pure helper (a) builds the "reply with ONLY this JSON" instruction appended to the prompt and (b) extracts the first balanced JSON object from free-text output. The bridges call (a) before the run and (b) after; the reprompt-on-failure orchestration lives in Task 11's `runModel`. Reuse the existing `extractJsonObject` shape from `agent/src/claude.ts` (lines 33-46) but make it return null instead of throwing, so the caller controls the reprompt.

**Files:**
- Create: `agent/src/providers/structured.ts`
- Create (test): `agent/src/providers/structured.test.ts`

**Steps:**

- [ ] Write the failing test `agent/src/providers/structured.test.ts`:
```ts
import { describe, expect, test } from "vitest";
import { structuredInstruction, extractJsonObjectLoose } from "./structured.js";

describe("structuredInstruction", () => {
  test("embeds the schema and demands JSON-only output", () => {
    const s = structuredInstruction("{\"type\":\"object\"}");
    expect(s).toMatch(/ONLY/i);
    expect(s).toContain("{\"type\":\"object\"}");
    expect(s).toMatch(/no prose|no markdown|no fences/i);
  });
});

describe("extractJsonObjectLoose", () => {
  test("parses a clean JSON object", () => {
    expect(extractJsonObjectLoose(`{"decision":"approve","confidence":0.9,"reason":"ok"}`)).toEqual({
      decision: "approve", confidence: 0.9, reason: "ok",
    });
  });
  test("tolerates a ```json fence and leading prose", () => {
    const out = "Sure, here is my verdict:\n```json\n{\"decision\":\"reject\",\"confidence\":0.3,\"reason\":\"no\"}\n```";
    expect(extractJsonObjectLoose(out)).toEqual({ decision: "reject", confidence: 0.3, reason: "no" });
  });
  test("returns null on output with no JSON object", () => {
    expect(extractJsonObjectLoose("I cannot answer that.")).toBeNull();
  });
  test("returns null on a truncated/broken object", () => {
    expect(extractJsonObjectLoose(`{"decision":"approve",`)).toBeNull();
  });
});
```

- [ ] Run it, expect FAIL: `npm --prefix agent test -- providers/structured`

- [ ] Create `agent/src/providers/structured.ts`:
```ts
/**
 * Structured-output support for providers WITHOUT a native --json-schema flag
 * (codex, gemini, opencode). We append a strict "reply with ONLY this JSON"
 * instruction to the prompt and parse the model's reply by extracting the first
 * balanced JSON object. runModel handles the ONE reprompt on parse failure; this
 * module is pure (no IO) so it can be unit-tested in isolation.
 */

/** The instruction appended to the prompt to force schema-shaped JSON-only output. */
export function structuredInstruction(jsonSchema: string): string {
  return [
    "Reply with ONLY a single JSON object that conforms to this JSON Schema.",
    "No prose, no markdown, no code fences — just the raw JSON object on its own.",
    "",
    "JSON Schema:",
    jsonSchema,
  ].join("\n");
}

/**
 * Extract the first balanced JSON object from free-text output. Tolerates leading
 * prose and ```json fences (strips a fence, then scans the first "{" to the last
 * "}"). Returns null on anything unparseable so the caller can reprompt/fail closed
 * rather than throwing. Mirrors extractJsonObject in agent/src/claude.ts but
 * non-throwing.
 */
export function extractJsonObjectLoose(raw: string): Record<string, unknown> | null {
  let text = raw.trim();
  // Strip a surrounding/embedded ```json … ``` fence if present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) text = fence[1].trim();

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Fall back to the substring from the first "{" to the last "}".
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}
```

- [ ] Run it, expect PASS: `npm --prefix agent test -- providers/structured`

- [ ] Commit:
```
git add agent/src/providers/structured.ts agent/src/providers/structured.test.ts
git commit -m "feat(agent): structured-output instruction + loose JSON extractor"
```

---

## Task 7 — Codex bridge

Mirror `apps/server/src/codexBridge.ts`. Build `codex exec --json …` argv (no `-a` flag; `-c approval_policy=never`; workspace-write + network), map the codex event schema to `CollectedEvent`s, run through `collectJsonlRun` with the guarded-kubectl shim prepended to PATH. Auth: `CODEX_API_KEY` (per `agentConfig.codexAuthEnv`). The system prompt is PREPENDED to the user prompt (codex has no append-system-prompt flag). For a structured turn, the structured instruction is appended to the prompt.

**Files:**
- Create: `agent/src/providers/codex.ts`
- Create (test): `agent/src/providers/codex.test.ts`

**Steps:**

- [ ] Write the failing test `agent/src/providers/codex.test.ts`:
```ts
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { buildCodexArgs, mapCodexEvent, codexBridge } from "./codex.js";

describe("buildCodexArgs", () => {
  test("emits the headless read-only-via-shim flag set + prompt", () => {
    const argv = buildCodexArgs("list pods", { model: "gpt-5-codex", prompt: "list pods" } as any);
    expect(argv[0]).toBe("codex");
    expect(argv[1]).toBe("exec");
    expect(argv).toContain("--json");
    expect(argv).not.toContain("-a");
    expect(argv).toContain("approval_policy=never");
    expect(argv).toContain("sandbox_mode=workspace-write");
    expect(argv).toContain("sandbox_workspace_write.network_access=true");
    expect(argv).toContain("--skip-git-repo-check");
    const mIdx = argv.indexOf("-m");
    expect(mIdx).toBeGreaterThan(-1);
    expect(argv[mIdx + 1]).toBe("gpt-5-codex");
    expect(argv[argv.length - 1]).toBe("list pods");
  });
  test("no -m when model is absent or a bare Claude alias", () => {
    expect(buildCodexArgs("hi", { prompt: "hi" } as any)).not.toContain("-m");
    expect(buildCodexArgs("hi", { model: "opus", prompt: "hi" } as any)).not.toContain("-m");
  });
});

describe("mapCodexEvent", () => {
  test("thread.started → session", () => {
    expect(mapCodexEvent({ type: "thread.started", thread_id: "t1" })).toEqual([{ type: "session", sessionId: "t1" }]);
  });
  test("agent_message item.completed → text", () => {
    expect(mapCodexEvent({ type: "item.completed", item: { type: "agent_message", text: "done" } })).toEqual([{ type: "text", text: "done" }]);
  });
  test("turn.failed → error", () => {
    expect(mapCodexEvent({ type: "turn.failed", error: { message: "rate limited" } })).toEqual([{ type: "error", text: "rate limited" }]);
  });
  test("transient Reconnecting errors are suppressed", () => {
    expect(mapCodexEvent({ type: "error", message: "Reconnecting... 2/5" })).toEqual([]);
  });
  test("unknown events → []", () => {
    expect(mapCodexEvent({ type: "turn.started" })).toEqual([]);
    expect(mapCodexEvent(null)).toEqual([]);
  });
});

describe("codexBridge.authEnv", () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.CODEX_API_KEY; });
  afterEach(() => { process.env = { ...saved }; });
  test("null without CODEX_API_KEY", () => { expect(codexBridge.authEnv()).toBeNull(); });
  test("CODEX_API_KEY env when present", () => {
    process.env.CODEX_API_KEY = "sk-codex";
    expect(codexBridge.authEnv()).toEqual({ CODEX_API_KEY: "sk-codex" });
  });
});
```

- [ ] Run it, expect FAIL: `npm --prefix agent test -- providers/codex`

- [ ] Create `agent/src/providers/codex.ts`:
```ts
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionGuardBin } from "../guardedKubectl.js";
import { collectJsonlRun, type CollectedEvent } from "./process.js";
import { structuredInstruction, extractJsonObjectLoose } from "./structured.js";
import { errorResult, type ProviderBridge, type ProviderResult, type RunModelInput } from "./types.js";

const CLAUDE_ALIASES = new Set(["opus", "sonnet", "haiku"]);

/** Build `codex exec --json …` argv. Pure + exported for unit tests. Mirrors
 *  apps/server/src/codexBridge.ts buildCodexArgs. The fullPrompt positional already
 *  embeds the system prompt (codex has no append-system-prompt flag). */
export function buildCodexArgs(fullPrompt: string, input: RunModelInput): string[] {
  const flags = [
    "--json",
    "-c", "sandbox_mode=workspace-write",
    "-c", "sandbox_workspace_write.network_access=true",
    "-c", "approval_policy=never",
    "--skip-git-repo-check",
  ];
  if (input.model && !CLAUDE_ALIASES.has(input.model)) flags.push("-m", input.model);
  if (input.resumeSessionId) {
    return ["codex", "exec", "resume", input.resumeSessionId, ...flags, fullPrompt];
  }
  return ["codex", "exec", ...flags, fullPrompt];
}

function truncate(raw: string): string {
  return raw.length > 600 ? raw.slice(0, 600) + "…" : raw;
}

/** Map ONE codex --json event to CollectedEvents. Mirrors mapCodexEvent in the chat. */
export function mapCodexEvent(ev: any): CollectedEvent[] {
  if (!ev || typeof ev !== "object") return [];
  if (ev.type === "thread.started" && typeof ev.thread_id === "string") {
    return [{ type: "session", sessionId: ev.thread_id }];
  }
  if (ev.type === "turn.completed") return [{ type: "done" }];
  if (ev.type === "turn.failed") {
    const msg = ev.error?.message;
    return [{ type: "error", text: typeof msg === "string" ? msg : "Codex turn failed" }];
  }
  if (ev.type === "error") {
    const text = typeof ev.message === "string" ? ev.message : "Codex error";
    if (/^Reconnecting/i.test(text)) return [];
    return [{ type: "error", text }];
  }
  if (ev.type === "item.completed") {
    const item = ev.item;
    if (!item || typeof item !== "object") return [];
    if (item.type === "agent_message" && typeof item.text === "string") {
      return [{ type: "text", text: item.text }];
    }
    if (item.type === "reasoning" && typeof item.text === "string") {
      return [{ type: "thinking", text: truncate(item.text) }];
    }
  }
  return [];
}

export const codexBridge: ProviderBridge = {
  id: "codex",

  authEnv(): Record<string, string> | null {
    const key = process.env.CODEX_API_KEY;
    return key && key.trim() ? { CODEX_API_KEY: key } : null;
  },

  async run(input: RunModelInput): Promise<ProviderResult> {
    const workspaceDir = await mkdtemp(join(tmpdir(), "rigel-codex-"));
    let guardBin: string | undefined;
    try {
      guardBin = await provisionGuardBin();
      const auth = this.authEnv();
      if (!auth) return errorResult("Codex has no CODEX_API_KEY — add a key for this provider.");

      const fullPrompt = composeCodexPrompt(input);
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        ...auth,
        PATH: `${guardBin}${path.delimiter}${process.env.PATH ?? ""}`,
      };
      const run = await collectJsonlRun({
        argv: buildCodexArgs(fullPrompt, input),
        env,
        cwd: workspaceDir,
        signal: input.signal,
        timeoutMs: input.timeoutMs,
        mapEvent: mapCodexEvent,
      });
      if (run.isError) return errorResult(run.errorText ?? "Codex run failed");
      const structuredOutput = input.structuredSchema ? extractJsonObjectLoose(run.text) ?? undefined : undefined;
      return { text: run.text, costUsd: 0, isError: false, sessionId: run.sessionId, structuredOutput };
    } catch (e) {
      return errorResult(String(e instanceof Error ? e.message : e));
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
      if (guardBin) await rm(guardBin, { recursive: true, force: true });
    }
  },
};

/** System prompt + (optional structured instruction) + user prompt as one positional. */
function composeCodexPrompt(input: RunModelInput): string {
  const head = input.systemPrompt ? `${input.systemPrompt}\n\n` : "";
  const struct = input.structuredSchema ? `\n\n${structuredInstruction(input.structuredSchema)}` : "";
  return `${head}# Task\n${input.prompt}${struct}`;
}
```

- [ ] Run it, expect PASS: `npm --prefix agent test -- providers/codex`

- [ ] Commit:
```
git add agent/src/providers/codex.ts agent/src/providers/codex.test.ts
git commit -m "feat(agent): codex bridge (codex exec --json + guarded shim)"
```

---

## Task 8 — Gemini bridge

Mirror `apps/server/src/geminiBridge.ts`. Build `gemini -p <fullPrompt> -o stream-json --approval-mode yolo [-m <model>]`, map the stream-json event schema, run through `collectJsonlRun` with the guard shim. Auth: `GEMINI_API_KEY` (per `agentConfig.geminiAuthEnv`). Fresh per turn (no resume), exactly as the chat documents.

**Files:**
- Create: `agent/src/providers/gemini.ts`
- Create (test): `agent/src/providers/gemini.test.ts`

**Steps:**

- [ ] Write the failing test `agent/src/providers/gemini.test.ts`:
```ts
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { buildGeminiArgs, mapGeminiEvent, geminiBridge } from "./gemini.js";

describe("buildGeminiArgs", () => {
  test("headless stream-json + yolo + model", () => {
    const argv = buildGeminiArgs("why crash?", { model: "gemini-2.5-pro", prompt: "why crash?" } as any);
    expect(argv[0]).toBe("gemini");
    expect(argv).toContain("-p");
    expect(argv).toContain("-o");
    expect(argv).toContain("stream-json");
    expect(argv).toContain("--approval-mode");
    expect(argv).toContain("yolo");
    const mIdx = argv.indexOf("-m");
    expect(argv[mIdx + 1]).toBe("gemini-2.5-pro");
  });
  test("no -m for a bare Claude alias or absent model", () => {
    expect(buildGeminiArgs("hi", { model: "sonnet", prompt: "hi" } as any)).not.toContain("-m");
    expect(buildGeminiArgs("hi", { prompt: "hi" } as any)).not.toContain("-m");
  });
});

describe("mapGeminiEvent", () => {
  test("init → session", () => {
    expect(mapGeminiEvent({ type: "init", session_id: "g1" })).toEqual([{ type: "session", sessionId: "g1" }]);
  });
  test("assistant message → text", () => {
    expect(mapGeminiEvent({ type: "message", role: "assistant", content: "hello" })).toEqual([{ type: "text", text: "hello" }]);
  });
  test("user message → ignored", () => {
    expect(mapGeminiEvent({ type: "message", role: "user", content: "echo" })).toEqual([]);
  });
  test("error severity error → error; warning → ignored", () => {
    expect(mapGeminiEvent({ type: "error", severity: "error", message: "boom" })).toEqual([{ type: "error", text: "boom" }]);
    expect(mapGeminiEvent({ type: "error", severity: "warning", message: "meh" })).toEqual([]);
  });
  test("result status error → error then done; success → done", () => {
    expect(mapGeminiEvent({ type: "result", status: "error", error: { message: "fail" } })).toEqual([
      { type: "error", text: "fail" }, { type: "done" },
    ]);
    expect(mapGeminiEvent({ type: "result", status: "success" })).toEqual([{ type: "done" }]);
  });
});

describe("geminiBridge.authEnv", () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.GEMINI_API_KEY; });
  afterEach(() => { process.env = { ...saved }; });
  test("null without GEMINI_API_KEY", () => { expect(geminiBridge.authEnv()).toBeNull(); });
  test("GEMINI_API_KEY when present", () => {
    process.env.GEMINI_API_KEY = "g-key";
    expect(geminiBridge.authEnv()).toEqual({ GEMINI_API_KEY: "g-key" });
  });
});
```

- [ ] Run it, expect FAIL: `npm --prefix agent test -- providers/gemini`

- [ ] Create `agent/src/providers/gemini.ts`:
```ts
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionGuardBin } from "../guardedKubectl.js";
import { collectJsonlRun, type CollectedEvent } from "./process.js";
import { structuredInstruction, extractJsonObjectLoose } from "./structured.js";
import { errorResult, type ProviderBridge, type ProviderResult, type RunModelInput } from "./types.js";

const CLAUDE_ALIASES = new Set(["opus", "sonnet", "haiku"]);

/** Build `gemini …` argv. Pure + exported. Mirrors apps/server geminiBridge.
 *  --approval-mode yolo auto-approves tools (the guard shim still denies mutations).
 *  No resume: gemini runs fresh per turn (documented limitation). */
export function buildGeminiArgs(fullPrompt: string, input: RunModelInput): string[] {
  const argv = ["gemini", "-p", fullPrompt, "-o", "stream-json", "--approval-mode", "yolo"];
  if (input.model && !CLAUDE_ALIASES.has(input.model)) argv.push("-m", input.model);
  return argv;
}

/** Map ONE gemini stream-json event. Mirrors mapGeminiEvent in the chat. */
export function mapGeminiEvent(ev: any): CollectedEvent[] {
  if (!ev || typeof ev !== "object") return [];
  if (ev.type === "init") {
    return typeof ev.session_id === "string" ? [{ type: "session", sessionId: ev.session_id }] : [];
  }
  if (ev.type === "message") {
    return ev.role === "assistant" && typeof ev.content === "string" ? [{ type: "text", text: ev.content }] : [];
  }
  if (ev.type === "error") {
    return ev.severity === "error"
      ? [{ type: "error", text: typeof ev.message === "string" ? ev.message : "Gemini error" }]
      : [];
  }
  if (ev.type === "result") {
    if (ev.status === "error") {
      const msg = ev.error?.message;
      return [{ type: "error", text: typeof msg === "string" ? msg : "Gemini turn failed" }, { type: "done" }];
    }
    return [{ type: "done" }];
  }
  return [];
}

export const geminiBridge: ProviderBridge = {
  id: "gemini",

  authEnv(): Record<string, string> | null {
    const key = process.env.GEMINI_API_KEY;
    return key && key.trim() ? { GEMINI_API_KEY: key } : null;
  },

  async run(input: RunModelInput): Promise<ProviderResult> {
    const workspaceDir = await mkdtemp(join(tmpdir(), "rigel-gemini-"));
    let guardBin: string | undefined;
    try {
      guardBin = await provisionGuardBin();
      const auth = this.authEnv();
      if (!auth) return errorResult("Gemini has no GEMINI_API_KEY — add a key for this provider.");

      const head = input.systemPrompt ? `${input.systemPrompt}\n\n` : "";
      const struct = input.structuredSchema ? `\n\n${structuredInstruction(input.structuredSchema)}` : "";
      const fullPrompt = `${head}# Task\n${input.prompt}${struct}`;

      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        ...auth,
        PATH: `${guardBin}${path.delimiter}${process.env.PATH ?? ""}`,
      };
      const run = await collectJsonlRun({
        argv: buildGeminiArgs(fullPrompt, input),
        env,
        cwd: workspaceDir,
        signal: input.signal,
        timeoutMs: input.timeoutMs,
        mapEvent: mapGeminiEvent,
      });
      if (run.isError) return errorResult(run.errorText ?? "Gemini run failed");
      const structuredOutput = input.structuredSchema ? extractJsonObjectLoose(run.text) ?? undefined : undefined;
      return { text: run.text, costUsd: 0, isError: false, sessionId: run.sessionId, structuredOutput };
    } catch (e) {
      return errorResult(String(e instanceof Error ? e.message : e));
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
      if (guardBin) await rm(guardBin, { recursive: true, force: true });
    }
  },
};
```

- [ ] Run it, expect PASS: `npm --prefix agent test -- providers/gemini`

- [ ] Commit:
```
git add agent/src/providers/gemini.ts agent/src/providers/gemini.test.ts
git commit -m "feat(agent): gemini bridge (gemini -o stream-json + guarded shim)"
```

---

## Task 9 — OpenCode bridge

Mirror `apps/server/src/opencodeBridge.ts`. Build `opencode run --format json --thinking --dir <runDir> [-s <session>] [-m <model>] <fullPrompt>`, write an `opencode.json` permission config into `<runDir>` (`{"*":"allow","edit":"deny","webfetch":"deny","websearch":"deny"}`), map the opencode event schema, synthesize `done` on clean exit. Auth: OpenCode is login-managed (`OPENCODE_AUTH_CONTENT` blob OR `opencodeApiKey`). Per the spec it accepts either; treat the bridge as authenticated when `OPENCODE_AUTH_CONTENT` or `OPENCODE_API_KEY` is set, injecting whichever is present.

**Files:**
- Create: `agent/src/providers/opencode.ts`
- Create (test): `agent/src/providers/opencode.test.ts`

**Steps:**

- [ ] Write the failing test `agent/src/providers/opencode.test.ts`:
```ts
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { buildOpencodeArgs, mapOpencodeEvent, opencodeBridge } from "./opencode.js";

describe("buildOpencodeArgs", () => {
  test("headless json + thinking + dir + model + trailing prompt", () => {
    const argv = buildOpencodeArgs("hi", { model: "anthropic/claude-x", prompt: "hi" } as any, "/run/dir");
    expect(argv.slice(0, 2)).toEqual(["opencode", "run"]);
    expect(argv).toContain("--format");
    expect(argv).toContain("json");
    expect(argv).toContain("--thinking");
    const dIdx = argv.indexOf("--dir");
    expect(argv[dIdx + 1]).toBe("/run/dir");
    const mIdx = argv.indexOf("-m");
    expect(argv[mIdx + 1]).toBe("anthropic/claude-x");
    expect(argv[argv.length - 1]).toBe("hi");
  });
  test("resume inserts -s <sessionId>", () => {
    const argv = buildOpencodeArgs("go", { sessionId: "oc1", prompt: "go" } as any, "/d");
    const sIdx = argv.indexOf("-s");
    expect(argv[sIdx + 1]).toBe("oc1");
  });
  test("no -m for a bare Claude alias", () => {
    expect(buildOpencodeArgs("hi", { model: "opus", prompt: "hi" } as any, "/d")).not.toContain("-m");
  });
});

describe("mapOpencodeEvent", () => {
  test("text part → text", () => {
    expect(mapOpencodeEvent({ type: "text", part: { text: "answer" } })).toEqual([{ type: "text", text: "answer" }]);
  });
  test("step_start with sessionID → session", () => {
    expect(mapOpencodeEvent({ type: "step_start", sessionID: "oc9" })).toEqual([{ type: "session", sessionId: "oc9" }]);
  });
  test("error → error (structured message preferred)", () => {
    expect(mapOpencodeEvent({ type: "error", error: { data: { message: "no creds" } } })).toEqual([{ type: "error", text: "no creds" }]);
  });
  test("unknown → []", () => {
    expect(mapOpencodeEvent({ type: "step_finish" })).toEqual([]);
    expect(mapOpencodeEvent(null)).toEqual([]);
  });
});

describe("opencodeBridge.authEnv", () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.OPENCODE_AUTH_CONTENT; delete process.env.OPENCODE_API_KEY; });
  afterEach(() => { process.env = { ...saved }; });
  test("null with no opencode credential", () => { expect(opencodeBridge.authEnv()).toBeNull(); });
  test("OPENCODE_AUTH_CONTENT blob when present", () => {
    process.env.OPENCODE_AUTH_CONTENT = "{...}";
    expect(opencodeBridge.authEnv()).toEqual({ OPENCODE_AUTH_CONTENT: "{...}" });
  });
  test("OPENCODE_API_KEY when present", () => {
    process.env.OPENCODE_API_KEY = "oc-key";
    expect(opencodeBridge.authEnv()).toEqual({ OPENCODE_API_KEY: "oc-key" });
  });
});
```

- [ ] Run it, expect FAIL: `npm --prefix agent test -- providers/opencode`

- [ ] Create `agent/src/providers/opencode.ts`:
```ts
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionGuardBin } from "../guardedKubectl.js";
import { collectJsonlRun, type CollectedEvent } from "./process.js";
import { structuredInstruction, extractJsonObjectLoose } from "./structured.js";
import { errorResult, type ProviderBridge, type ProviderResult, type RunModelInput } from "./types.js";

const CLAUDE_ALIASES = new Set(["opus", "sonnet", "haiku"]);

/** Build `opencode run …` argv. Pure + exported. Mirrors apps/server opencodeBridge. */
export function buildOpencodeArgs(fullPrompt: string, input: RunModelInput, runDir: string): string[] {
  const flags = ["--format", "json", "--thinking", "--dir", runDir];
  if (input.model && !CLAUDE_ALIASES.has(input.model)) flags.push("-m", input.model);
  if (input.resumeSessionId) return ["opencode", "run", ...flags, "-s", input.resumeSessionId, fullPrompt];
  return ["opencode", "run", ...flags, fullPrompt];
}

function truncate(raw: string): string {
  return raw.length > 600 ? raw.slice(0, 600) + "…" : raw;
}

/** Map ONE opencode --format json event. Mirrors mapOpencodeEvent in the chat. */
export function mapOpencodeEvent(ev: any): CollectedEvent[] {
  if (!ev || typeof ev !== "object") return [];
  if (ev.type === "text") {
    const t = ev.part?.text;
    return typeof t === "string" && t.length > 0 ? [{ type: "text", text: t }] : [];
  }
  if (ev.type === "reasoning") {
    const t = ev.part?.text;
    return typeof t === "string" && t.length > 0 ? [{ type: "thinking", text: truncate(t) }] : [];
  }
  if (ev.type === "step_start") {
    return typeof ev.sessionID === "string" ? [{ type: "session", sessionId: ev.sessionID }] : [];
  }
  if (ev.type === "step_finish") return [];
  if (ev.type === "error") {
    const msg = ev.error?.data?.message;
    const text =
      typeof msg === "string" && msg.length > 0
        ? msg
        : typeof ev.error?.name === "string"
          ? ev.error.name
          : "opencode error";
    return [{ type: "error", text }];
  }
  return [];
}

export const opencodeBridge: ProviderBridge = {
  id: "opencode",

  authEnv(): Record<string, string> | null {
    const blob = process.env.OPENCODE_AUTH_CONTENT;
    if (blob && blob.trim()) return { OPENCODE_AUTH_CONTENT: blob };
    const key = process.env.OPENCODE_API_KEY;
    if (key && key.trim()) return { OPENCODE_API_KEY: key };
    return null;
  },

  async run(input: RunModelInput): Promise<ProviderResult> {
    const runDir = await mkdtemp(join(tmpdir(), "rigel-opencode-"));
    // Headless permission config: allow by default (read-only kubectl runs), DENY
    // edit/webfetch/websearch, no "ask" (would stall headless). The guard shim still
    // denies cluster mutations on top of the allowed bash tool.
    await writeFile(
      join(runDir, "opencode.json"),
      JSON.stringify({ permission: { "*": "allow", edit: "deny", webfetch: "deny", websearch: "deny" } }),
    );
    let guardBin: string | undefined;
    try {
      guardBin = await provisionGuardBin();
      const auth = this.authEnv();
      if (!auth) return errorResult("OpenCode has no credential — add OPENCODE_AUTH_CONTENT or OPENCODE_API_KEY.");

      const head = input.systemPrompt ? `${input.systemPrompt}\n\n` : "";
      const struct = input.structuredSchema ? `\n\n${structuredInstruction(input.structuredSchema)}` : "";
      const fullPrompt = `${head}# Task\n${input.prompt}${struct}`;

      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        ...auth,
        PATH: `${guardBin}${path.delimiter}${process.env.PATH ?? ""}`,
      };
      const run = await collectJsonlRun({
        argv: buildOpencodeArgs(fullPrompt, input, runDir),
        env,
        signal: input.signal,
        timeoutMs: input.timeoutMs,
        mapEvent: mapOpencodeEvent,
      });
      if (run.isError) return errorResult(run.errorText ?? "OpenCode run failed");
      const structuredOutput = input.structuredSchema ? extractJsonObjectLoose(run.text) ?? undefined : undefined;
      return { text: run.text, costUsd: 0, isError: false, sessionId: run.sessionId, structuredOutput };
    } catch (e) {
      return errorResult(String(e instanceof Error ? e.message : e));
    } finally {
      await rm(runDir, { recursive: true, force: true });
      if (guardBin) await rm(guardBin, { recursive: true, force: true });
    }
  },
};
```

- [ ] Run it, expect PASS: `npm --prefix agent test -- providers/opencode`

- [ ] Commit:
```
git add agent/src/providers/opencode.ts agent/src/providers/opencode.test.ts
git commit -m "feat(agent): opencode bridge (opencode run --format json + perm config)"
```

---

## Task 10 — Extend `runtimeConfig.ts`: per-role selections + operational limits

Add per-role `{provider, model, effort}` parsing to `readRuntimeConfig` from the `assistant-config` ConfigMap, plus the operational limits that are install-time env today (poll interval, max per resource/hr, max per night, attempts per incident, confirm polls, monitor namespaces) so they become live. Backward-compat: when no role keys exist, default `worker = claude/<env WORKER_MODEL or claude-sonnet-4-6>`, `supervisor = claude/<env SUPERVISOR_MODEL or claude-opus-4-8>`. When a limit key is absent, fall back to the value the `Config` already carries (passed in). Existing `RuntimeConfig` fields and tests are untouched.

The ConfigMap keys: `workerProvider`, `workerModel`, `workerEffort`, `supervisorProvider`, `supervisorModel`, `supervisorEffort`, and limits `pollIntervalMs`, `maxPerResourcePerHour`, `maxPerNight`, `maxAttemptsPerIncident`, `confirmPolls`, `namespaces`.

**Files:**
- Modify: `agent/src/runtimeConfig.ts` (add fields to `RuntimeConfig` interface lines 19-33; extend the return object in `readRuntimeConfig` lines 88-99; add parse helpers; both fail-closed early-return objects at lines 70 and 75 must also carry the new fields)
- Modify (test): `agent/src/runtimeConfig.test.ts` (add a describe block; CFG const at line 8 must gain the legacy model fields so defaults resolve)

**Steps:**

- [ ] Add the failing test to `agent/src/runtimeConfig.test.ts`. First update the `CFG` const (line 8) to carry the fallback fields the parser reads from `Config`:
```ts
const CFG = {
  configConfigMap: "assistant-config",
  stateNamespace: "default",
  workerModel: "claude-sonnet-4-6",
  supervisorModel: "claude-opus-4-8",
  pollIntervalMs: 30_000,
  maxPerResourcePerHour: 3,
  maxPerNight: 20,
  maxAttemptsPerIncident: 3,
  confirmPolls: 2,
  namespaces: [],
} as unknown as Config;
```
Then append:
```ts
describe("readRuntimeConfig — role selections", () => {
  test("defaults to claude worker=sonnet supervisor=opus when no role keys are set", async () => {
    mockConfigMap({ enabled: "true" });
    const rc = await readRuntimeConfig(CFG);
    expect(rc.worker).toEqual({ provider: "claude", model: "claude-sonnet-4-6", effort: undefined });
    expect(rc.supervisor).toEqual({ provider: "claude", model: "claude-opus-4-8", effort: undefined });
  });

  test("parses an explicit per-role provider/model/effort", async () => {
    mockConfigMap({
      enabled: "true",
      workerProvider: "gemini", workerModel: "gemini-2.5-pro",
      supervisorProvider: "claude", supervisorModel: "claude-opus-4-8", supervisorEffort: "high",
    });
    const rc = await readRuntimeConfig(CFG);
    expect(rc.worker).toEqual({ provider: "gemini", model: "gemini-2.5-pro", effort: undefined });
    expect(rc.supervisor).toEqual({ provider: "claude", model: "claude-opus-4-8", effort: "high" });
  });

  test("an unknown provider value falls back to claude (safe default)", async () => {
    mockConfigMap({ enabled: "true", workerProvider: "bogus", workerModel: "x" });
    const rc = await readRuntimeConfig(CFG);
    expect(rc.worker.provider).toBe("claude");
  });

  test("an empty model string falls back to the Config legacy model", async () => {
    mockConfigMap({ enabled: "true", workerProvider: "claude", workerModel: "  " });
    const rc = await readRuntimeConfig(CFG);
    expect(rc.worker.model).toBe("claude-sonnet-4-6");
  });
});

describe("readRuntimeConfig — operational limits", () => {
  test("falls back to Config values when limit keys are absent", async () => {
    mockConfigMap({ enabled: "true" });
    const rc = await readRuntimeConfig(CFG);
    expect(rc.limits).toEqual({
      pollIntervalMs: 30_000, maxPerResourcePerHour: 3, maxPerNight: 20,
      maxAttemptsPerIncident: 3, confirmPolls: 2, namespaces: [],
    });
  });

  test("parses overrides and ignores non-numeric junk (keeps the Config fallback)", async () => {
    mockConfigMap({
      enabled: "true",
      pollIntervalMs: "15000", maxPerNight: "5", confirmPolls: "nope", namespaces: "default, kube-system",
    });
    const rc = await readRuntimeConfig(CFG);
    expect(rc.limits.pollIntervalMs).toBe(15000);
    expect(rc.limits.maxPerNight).toBe(5);
    expect(rc.limits.confirmPolls).toBe(2); // junk → Config fallback
    expect(rc.limits.namespaces).toEqual(["default", "kube-system"]);
  });

  test("role selections are claude defaults even on an unreadable config map (fail-closed)", async () => {
    vi.mocked(kubectl).mockResolvedValueOnce({ stdout: "", stderr: "nf", code: 1 });
    const rc = await readRuntimeConfig(CFG);
    expect(rc.enabled).toBe(false);
    expect(rc.worker.provider).toBe("claude");
    expect(rc.limits.pollIntervalMs).toBe(30_000);
  });
});
```

- [ ] Run it, expect FAIL: `npm --prefix agent test -- runtimeConfig`

- [ ] Implement in `agent/src/runtimeConfig.ts`. Add the import and types at the top (after the existing imports, lines 1-3):
```ts
import type { ProviderId, RoleSelection } from "./providers/types.js";

export interface OperationalLimits {
  pollIntervalMs: number;
  maxPerResourcePerHour: number;
  maxPerNight: number;
  maxAttemptsPerIncident: number;
  confirmPolls: number;
  namespaces: string[];
}

const PROVIDERS = new Set<ProviderId>(["claude", "codex", "gemini", "opencode"]);
```
Add to the `RuntimeConfig` interface (inside the interface, after `alertRules` at line 32):
```ts
  worker: RoleSelection;
  supervisor: RoleSelection;
  limits: OperationalLimits;
```
Add these parse helpers (after `parseAlertRulesFromConfig`, before `parseWindow`):
```ts
/** Parse one role's {provider, model, effort} from the config data, with
 *  backward-compat fallbacks: provider→claude, model→the legacy Config model. */
export function parseRoleSelection(
  data: Record<string, string>,
  role: "worker" | "supervisor",
  fallbackModel: string,
): RoleSelection {
  const rawProvider = (data[`${role}Provider`] ?? "").trim();
  const provider = PROVIDERS.has(rawProvider as ProviderId) ? (rawProvider as ProviderId) : "claude";
  const rawModel = (data[`${role}Model`] ?? "").trim();
  const model = rawModel || fallbackModel;
  const rawEffort = (data[`${role}Effort`] ?? "").trim();
  return { provider, model, effort: rawEffort || undefined };
}

/** Parse one numeric limit, falling back to the Config value on absence/junk. */
function numKey(data: Record<string, string>, key: string, fallback: number): number {
  const raw = (data[key] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Parse the operational limits, each falling back to the deploy-time Config value. */
export function parseLimits(data: Record<string, string>, cfg: Config): OperationalLimits {
  const rawNs = (data["namespaces"] ?? "").trim();
  const namespaces = rawNs
    ? rawNs.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
    : cfg.namespaces;
  return {
    pollIntervalMs: numKey(data, "pollIntervalMs", cfg.pollIntervalMs),
    maxPerResourcePerHour: numKey(data, "maxPerResourcePerHour", cfg.maxPerResourcePerHour),
    maxPerNight: numKey(data, "maxPerNight", cfg.maxPerNight),
    maxAttemptsPerIncident: numKey(data, "maxAttemptsPerIncident", cfg.maxAttemptsPerIncident),
    confirmPolls: numKey(data, "confirmPolls", cfg.confirmPolls),
    namespaces,
  };
}
```
Replace BOTH fail-closed early returns in `readRuntimeConfig` (lines 70 and 75 — the `code !== 0` and the JSON-parse catch) with a shared disabled-default that includes the new fields. Add this helper above `readRuntimeConfig`:
```ts
function disabledDefaults(cfg: Config): RuntimeConfig {
  return {
    enabled: false, mode: "auto", silenced: new Set(), window: undefined,
    signalRecipients: [], signalInbound: false, alertRules: [],
    worker: parseRoleSelection({}, "worker", cfg.workerModel),
    supervisor: parseRoleSelection({}, "supervisor", cfg.supervisorModel),
    limits: parseLimits({}, cfg),
  };
}
```
Then in `readRuntimeConfig`, change `if (res.code !== 0) return {…};` to `if (res.code !== 0) return disabledDefaults(cfg);` and the catch-block `return {…};` to `return disabledDefaults(cfg);`. Finally extend the success-path return object (lines 88-99) by adding three fields before the closing brace:
```ts
    worker: parseRoleSelection(data, "worker", cfg.workerModel),
    supervisor: parseRoleSelection(data, "supervisor", cfg.supervisorModel),
    limits: parseLimits(data, cfg),
```

- [ ] Run it, expect PASS: `npm --prefix agent test -- runtimeConfig`

- [ ] Run the FULL suite to confirm nothing regressed: `npm --prefix agent test`

- [ ] Commit:
```
git add agent/src/runtimeConfig.ts agent/src/runtimeConfig.test.ts
git commit -m "feat(agent): runtimeConfig parses per-role selections + live limits"
```

---

## Task 11 — `runModel.ts` dispatch (provider selection + structured reprompt + fail-close)

The single entry point worker/supervisor/diagnose call. It takes `{ role, prompt, allowedReads, systemPrompt, structuredSchema?, resumeSessionId?, signal, timeoutMs }`, reads the role's `RoleSelection` from `RuntimeConfig` (passed in — runModel does NOT re-read the ConfigMap; the loop already does each tick), picks the bridge, fails closed if no credential, runs, and for a structured turn with a non-Claude provider validates+reprompts ONCE. The `validateStructured` callback (supplied by the supervisor) decides if `structuredOutput` is acceptable; on a second failure runModel returns a fail-closed error (the supervisor maps that to "escalate").

**Files:**
- Create: `agent/src/runModel.ts`
- Create (test): `agent/src/runModel.test.ts`

**Steps:**

- [ ] Write the failing test `agent/src/runModel.test.ts`:
```ts
import { describe, expect, test, vi, afterEach } from "vitest";
import { runModel } from "./runModel.js";
import { claudeBridge } from "./providers/claude.js";
import { geminiBridge } from "./providers/gemini.js";
import type { RuntimeConfig } from "./runtimeConfig.js";

function rc(over: Partial<RuntimeConfig>): RuntimeConfig {
  return {
    enabled: true, mode: "auto", silenced: new Set(), signalRecipients: [], signalInbound: false, alertRules: [],
    worker: { provider: "claude", model: "claude-sonnet-4-6" },
    supervisor: { provider: "claude", model: "claude-opus-4-8" },
    limits: { pollIntervalMs: 30000, maxPerResourcePerHour: 3, maxPerNight: 20, maxAttemptsPerIncident: 3, confirmPolls: 2, namespaces: [] },
    ...over,
  } as RuntimeConfig;
}

afterEach(() => vi.restoreAllMocks());

describe("runModel dispatch", () => {
  test("routes the worker role to its provider bridge with model+systemPrompt+reads", async () => {
    const spy = vi.spyOn(claudeBridge, "authEnv").mockReturnValue({ CLAUDE_CODE_OAUTH_TOKEN: "t" });
    const runSpy = vi.spyOn(claudeBridge, "run").mockResolvedValue({ text: "ok", costUsd: 0, isError: false });
    const r = await runModel({
      role: "worker", config: rc({ worker: { provider: "claude", model: "claude-sonnet-4-6" } }),
      prompt: "p", systemPrompt: "sys", allowedReads: ["Bash(kubectl get *)"],
    });
    expect(r.isError).toBe(false);
    expect(runSpy).toHaveBeenCalledWith(expect.objectContaining({
      model: "claude-sonnet-4-6", prompt: "p", systemPrompt: "sys", allowedReads: ["Bash(kubectl get *)"],
    }));
    spy.mockRestore();
  });

  test("fails closed with a clear message when the selected provider has no credential", async () => {
    vi.spyOn(geminiBridge, "authEnv").mockReturnValue(null);
    const r = await runModel({ role: "worker", config: rc({ worker: { provider: "gemini", model: "gemini-2.5-pro" } }), prompt: "p" });
    expect(r.isError).toBe(true);
    expect(r.errorMessage).toMatch(/gemini/i);
    expect(r.errorMessage).toMatch(/key|credential/i);
  });

  test("Claude structured path passes structuredSchema straight through (no reprompt)", async () => {
    vi.spyOn(claudeBridge, "authEnv").mockReturnValue({ CLAUDE_CODE_OAUTH_TOKEN: "t" });
    const runSpy = vi.spyOn(claudeBridge, "run").mockResolvedValue({
      text: "{}", costUsd: 0, isError: false, structuredOutput: { decision: "approve" },
    });
    const r = await runModel({
      role: "supervisor", config: rc({ supervisor: { provider: "claude", model: "claude-opus-4-8" } }),
      prompt: "p", structuredSchema: "SCHEMA", validateStructured: (o: any) => o?.decision === "approve",
    });
    expect(r.structuredOutput).toEqual({ decision: "approve" });
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0][0].structuredSchema).toBe("SCHEMA");
  });

  test("non-Claude structured: reprompts ONCE on a bad verdict, then succeeds", async () => {
    vi.spyOn(geminiBridge, "authEnv").mockReturnValue({ GEMINI_API_KEY: "k" });
    const runSpy = vi.spyOn(geminiBridge, "run")
      .mockResolvedValueOnce({ text: "garbage", costUsd: 0, isError: false, structuredOutput: undefined })
      .mockResolvedValueOnce({ text: "{}", costUsd: 0, isError: false, structuredOutput: { decision: "reject" } });
    const r = await runModel({
      role: "supervisor", config: rc({ supervisor: { provider: "gemini", model: "gemini-2.5-pro" } }),
      prompt: "p", structuredSchema: "SCHEMA", validateStructured: (o: any) => o?.decision === "reject",
    });
    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(r.isError).toBe(false);
    expect(r.structuredOutput).toEqual({ decision: "reject" });
  });

  test("non-Claude structured: a second bad verdict fails closed (caller escalates)", async () => {
    vi.spyOn(geminiBridge, "authEnv").mockReturnValue({ GEMINI_API_KEY: "k" });
    vi.spyOn(geminiBridge, "run").mockResolvedValue({ text: "still bad", costUsd: 0, isError: false, structuredOutput: undefined });
    const r = await runModel({
      role: "supervisor", config: rc({ supervisor: { provider: "gemini", model: "gemini-2.5-pro" } }),
      prompt: "p", structuredSchema: "SCHEMA", validateStructured: () => false,
    });
    expect(r.isError).toBe(true);
    expect(r.errorMessage).toMatch(/structured|verdict|valid/i);
  });
});
```

- [ ] Run it, expect FAIL: `npm --prefix agent test -- runModel`

- [ ] Create `agent/src/runModel.ts`:
```ts
import type { RuntimeConfig } from "./runtimeConfig.js";
import { claudeBridge } from "./providers/claude.js";
import { codexBridge } from "./providers/codex.js";
import { geminiBridge } from "./providers/gemini.js";
import { opencodeBridge } from "./providers/opencode.js";
import { errorResult, type ProviderBridge, type ProviderId, type ProviderResult, type Role } from "./providers/types.js";

/** The provider bridges, by id. */
const BRIDGES: Record<ProviderId, ProviderBridge> = {
  claude: claudeBridge,
  codex: codexBridge,
  gemini: geminiBridge,
  opencode: opencodeBridge,
};

export interface RunModelOptions {
  /** Which role's selection to use. */
  role: Role;
  /** The live runtime config (already read this tick — runModel does NOT re-read). */
  config: RuntimeConfig;
  prompt: string;
  systemPrompt?: string;
  /** Read-only kubectl allowlist (Claude's --allowedTools; others use the shim). */
  allowedReads?: string[];
  /** Request structured JSON shaped by this JSON-Schema string. */
  structuredSchema?: string;
  /** Accept/reject the structuredOutput; required when structuredSchema is set.
   *  Returns true when the parsed verdict is acceptable. */
  validateStructured?: (output: unknown) => boolean;
  resumeSessionId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Single model-dispatch entry point. Reads the role's {provider, model, effort}
 * from the live config, selects the bridge, fails closed if no credential, and runs
 * one turn — returning the normalized ProviderResult. For a STRUCTURED turn on a
 * non-Claude provider (which has no --json-schema), it validates the parsed output
 * and REPROMPTS ONCE on failure; a second failure fails closed (the supervisor maps
 * that to "escalate" — never auto-approve on a bad verdict). Claude's structured
 * output is schema-validated by the CLI, so it passes straight through.
 */
export async function runModel(opts: RunModelOptions): Promise<ProviderResult> {
  const selection = opts.role === "worker" ? opts.config.worker : opts.config.supervisor;
  const bridge = BRIDGES[selection.provider];
  if (!bridge) return errorResult(`Unknown provider "${selection.provider}" for the ${opts.role} role.`);

  if (!bridge.authEnv()) {
    return errorResult(
      `${opts.role} provider ${selection.provider} has no credential — add a key for it.`,
    );
  }

  const base = {
    model: selection.model,
    prompt: opts.prompt,
    systemPrompt: opts.systemPrompt,
    allowedReads: opts.allowedReads,
    structuredSchema: opts.structuredSchema,
    effort: selection.effort,
    resumeSessionId: opts.resumeSessionId,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  };

  const first = await bridge.run(base);
  if (first.isError) return first;

  // No structured contract → return as-is.
  if (!opts.structuredSchema || !opts.validateStructured) return first;

  // Claude validates against the schema in-CLI; trust its structuredOutput.
  if (selection.provider === "claude") {
    if (first.structuredOutput !== undefined && opts.validateStructured(first.structuredOutput)) return first;
    return errorResult("Claude returned no valid structured verdict.");
  }

  // Non-Claude: validate the parsed JSON; reprompt ONCE on failure.
  if (first.structuredOutput !== undefined && opts.validateStructured(first.structuredOutput)) return first;

  const reprompt = await bridge.run({
    ...base,
    prompt: `${opts.prompt}\n\nYour previous reply was not a single valid JSON object matching the schema. Reply again with ONLY the JSON object — no prose, no fences.`,
  });
  if (reprompt.isError) return reprompt;
  if (reprompt.structuredOutput !== undefined && opts.validateStructured(reprompt.structuredOutput)) {
    return reprompt;
  }
  return errorResult("Provider did not return a valid structured verdict after one reprompt (fail-closed).");
}
```

- [ ] Run it, expect PASS: `npm --prefix agent test -- runModel`

- [ ] Commit:
```
git add agent/src/runModel.ts agent/src/runModel.test.ts
git commit -m "feat(agent): runModel role→provider dispatch with structured reprompt + fail-close"
```

---

## Task 12 — Refactor `worker.ts` to call `runModel`

`runWorker` currently calls `runClaude` directly with `cfg.workerModel`. Change its signature to accept the live `RuntimeConfig` and call `runModel({ role: "worker", … })`. Behavior is unchanged for the default Claude config. The `READ_ONLY_TOOLS` and `SYSTEM_PROMPT` constants and `parseActions`/`buildPrompt` are unchanged. On a fail-closed result, `runWorker` returns its analysis as the error text so `index.ts`'s existing fail-closed handling (lines 207-219) works; `costUsd` becomes 0.

**Files:**
- Modify: `agent/src/worker.ts` (imports line 2; `runWorker` signature + body lines 46-59)
- Modify (test): no existing `worker.test.ts`; create `agent/src/worker.test.ts`

**Steps:**

- [ ] Write the failing test `agent/src/worker.test.ts`:
```ts
import { describe, expect, test, vi, afterEach } from "vitest";
import { runWorker } from "./worker.js";
import * as runModelMod from "./runModel.js";
import type { RuntimeConfig } from "./runtimeConfig.js";
import type { Incident } from "./detector.js";

function rc(): RuntimeConfig {
  return {
    enabled: true, mode: "auto", silenced: new Set(), signalRecipients: [], signalInbound: false, alertRules: [],
    worker: { provider: "claude", model: "claude-sonnet-4-6" },
    supervisor: { provider: "claude", model: "claude-opus-4-8" },
    limits: { pollIntervalMs: 30000, maxPerResourcePerHour: 3, maxPerNight: 20, maxAttemptsPerIncident: 3, confirmPolls: 2, namespaces: [] },
  } as RuntimeConfig;
}
const INC: Incident = { incidentKind: "unhealthyPod", name: "nginx", namespace: "default", reason: "CrashLoopBackOff" } as Incident;

afterEach(() => vi.restoreAllMocks());

describe("runWorker", () => {
  test("calls runModel as the worker role with the read-only tools + system prompt", async () => {
    const spy = vi.spyOn(runModelMod, "runModel").mockResolvedValue({
      text: 'all good ```action\n{"label":"restart","kind":"restart","deployment":"nginx","namespace":"default"}\n```',
      costUsd: 0.01, isError: false,
    });
    const out = await runWorker(rc(), [INC]);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ role: "worker" }));
    const call = spy.mock.calls[0][0];
    expect(call.allowedReads).toContain("Bash(kubectl get *)");
    expect(call.systemPrompt).toMatch(/autonomous/i);
    expect(out.actions.length).toBe(1);
    expect(out.actions[0].kind).toBe("restart");
  });

  test("a fail-closed runModel result surfaces as an error analysis (no actions)", async () => {
    vi.spyOn(runModelMod, "runModel").mockResolvedValue({
      text: "", costUsd: 0, isError: true, errorMessage: "worker provider gemini has no credential",
    });
    const out = await runWorker(rc(), [INC]);
    expect(out.actions).toEqual([]);
    expect(out.analysis).toMatch(/no credential/);
  });
});
```

- [ ] Run it, expect FAIL: `npm --prefix agent test -- worker`

- [ ] Edit `agent/src/worker.ts`. Replace the import (line 2):
```ts
import { runModel } from "./runModel.js";
```
Add the runtime-config import (after the `Config` import, line 3):
```ts
import type { RuntimeConfig } from "./runtimeConfig.js";
```
Replace `runWorker` (lines 46-59):
```ts
export async function runWorker(rc: RuntimeConfig, incidents: Incident[]): Promise<WorkerOutput> {
  const result = await runModel({
    role: "worker",
    config: rc,
    prompt: buildPrompt(incidents),
    systemPrompt: SYSTEM_PROMPT,
    allowedReads: READ_ONLY_TOOLS,
    timeoutMs: 120_000,
  });
  if (result.isError) {
    // Fail closed: surface the error as analysis with no actions, so the loop's
    // existing fail-closed handling records a failure and never acts.
    return { actions: [], analysis: result.errorMessage ?? "worker failed", costUsd: 0 };
  }
  return {
    actions: parseActions(result.text),
    analysis: result.text,
    costUsd: result.costUsd,
  };
}
```

- [ ] Run it, expect PASS: `npm --prefix agent test -- worker`

- [ ] Commit:
```
git add agent/src/worker.ts agent/src/worker.test.ts
git commit -m "feat(agent): worker calls runModel (worker role) instead of runClaude"
```

---

## Task 13 — Refactor `supervisor.ts` to call `runModel` with structured verdict + reprompt

`runSupervisor` currently calls `runClaude` with `jsonSchema` and parses `structuredOutput`. Change its signature to accept `RuntimeConfig`, call `runModel({ role: "supervisor", structuredSchema: VERDICT_SCHEMA, validateStructured })`, and on a fail-closed result THROW (so `index.ts`'s existing supervisor catch at lines 251-261 queues + escalates). `parseVerdict` stays the source of truth for shape; `validateStructured` wraps it in a try/catch returning a boolean so a malformed verdict triggers the reprompt/escalate path. The non-Claude supervisor fail-close-to-escalate requirement is satisfied because a throw from `runSupervisor` is already mapped to "escalated/queued" in `index.ts`.

**Files:**
- Modify: `agent/src/supervisor.ts` (import line 1; `runSupervisor` signature + body lines 79-110)
- Modify (test): `agent/src/supervisor.test.ts` (add a `runSupervisor` describe block; existing `parseVerdict` tests unchanged)

**Steps:**

- [ ] Add the failing test block to `agent/src/supervisor.test.ts` (append after the existing `parseVerdict` describe). Add the imports at the top:
```ts
import { vi, afterEach } from "vitest";
import { runSupervisor } from "./supervisor.js";
import * as runModelMod from "./runModel.js";
import type { RuntimeConfig } from "./runtimeConfig.js";
import type { Incident } from "./detector.js";
import type { SuggestedAction } from "./action.js";
```
And the block:
```ts
function rc(): RuntimeConfig {
  return {
    enabled: true, mode: "auto", silenced: new Set(), signalRecipients: [], signalInbound: false, alertRules: [],
    worker: { provider: "claude", model: "claude-sonnet-4-6" },
    supervisor: { provider: "claude", model: "claude-opus-4-8" },
    limits: { pollIntervalMs: 30000, maxPerResourcePerHour: 3, maxPerNight: 20, maxAttemptsPerIncident: 3, confirmPolls: 2, namespaces: [] },
  } as RuntimeConfig;
}
const INC = { incidentKind: "degradedDeployment", name: "api", namespace: "default", reason: "Unavailable" } as Incident;
const ACT = { label: "rollback api", kind: "rollback", deployment: "api", namespace: "default" } as SuggestedAction;

describe("runSupervisor", () => {
  afterEach(() => vi.restoreAllMocks());

  test("calls runModel as supervisor with the verdict schema + a validator", async () => {
    const spy = vi.spyOn(runModelMod, "runModel").mockResolvedValue({
      text: "{}", costUsd: 0, isError: false, structuredOutput: { decision: "approve", confidence: 0.9, reason: "ok" },
    });
    const out = await runSupervisor(rc(), INC, ACT, "analysis", "kubectl rollout undo deploy/api");
    const call = spy.mock.calls[0][0];
    expect(call.role).toBe("supervisor");
    expect(typeof call.structuredSchema).toBe("string");
    expect(typeof call.validateStructured).toBe("function");
    expect(out.verdict.decision).toBe("approve");
  });

  test("the validator rejects a malformed verdict (so runModel would reprompt/escalate)", async () => {
    const spy = vi.spyOn(runModelMod, "runModel").mockResolvedValue({ text: "x", costUsd: 0, isError: false, structuredOutput: { decision: "yolo" } });
    await runSupervisor(rc(), INC, ACT, "a", "cmd");
    const validate = spy.mock.calls[0][0].validateStructured!;
    expect(validate({ decision: "approve", confidence: 0.9, reason: "ok" })).toBe(true);
    expect(validate({ decision: "yolo" })).toBe(false);
    expect(validate("not even an object")).toBe(false);
  });

  test("a fail-closed runModel result THROWS so the loop escalates (never auto-approves)", async () => {
    vi.spyOn(runModelMod, "runModel").mockResolvedValue({ text: "", costUsd: 0, isError: true, errorMessage: "no valid verdict after reprompt" });
    await expect(runSupervisor(rc(), INC, ACT, "a", "cmd")).rejects.toThrow(/verdict/i);
  });
});
```

- [ ] Run it, expect FAIL: `npm --prefix agent test -- supervisor`

- [ ] Edit `agent/src/supervisor.ts`. Replace the import (line 1):
```ts
import { runModel } from "./runModel.js";
```
Add the runtime-config import (after `Config`, line 2):
```ts
import type { RuntimeConfig } from "./runtimeConfig.js";
```
Replace `runSupervisor` (lines 79-110):
```ts
export async function runSupervisor(
  rc: RuntimeConfig,
  incident: Incident,
  action: SuggestedAction,
  workerAnalysis: string,
  command: string,
): Promise<SupervisorOutput> {
  const loc = incident.namespace ? `${incident.namespace}/${incident.name}` : incident.name;
  const prompt = `Incident: [${incident.incidentKind}] ${loc} — ${incident.reason}${
    incident.detail ? ` (${incident.detail})` : ""
  }

The worker proposed this remediation:
  label: ${action.label}
  kind: ${action.kind}
  command that will run: ${command}

Worker's analysis:
${workerAnalysis}

Independently verify against the live cluster (read-only), then return your verdict.`;

  const result = await runModel({
    role: "supervisor",
    config: rc,
    prompt,
    systemPrompt: SYSTEM_PROMPT,
    allowedReads: READ_ONLY_TOOLS,
    structuredSchema: VERDICT_SCHEMA,
    // Wrap parseVerdict in a boolean check so a malformed verdict triggers
    // runModel's one reprompt, then fail-closed (THROW → loop escalates).
    validateStructured: (o) => {
      try {
        parseVerdict(o);
        return true;
      } catch {
        return false;
      }
    },
    timeoutMs: 150_000,
  });

  if (result.isError) {
    // Fail closed: never auto-approve on a bad/absent verdict. The loop's existing
    // catch maps this throw to "escalated/queued".
    throw new Error(`supervisor verdict unavailable (fail-closed): ${result.errorMessage ?? "unknown error"}`);
  }
  return { verdict: parseVerdict(result.structuredOutput), costUsd: result.costUsd };
}
```

- [ ] Run it, expect PASS: `npm --prefix agent test -- supervisor`

- [ ] Commit:
```
git add agent/src/supervisor.ts agent/src/supervisor.test.ts
git commit -m "feat(agent): supervisor calls runModel with structured verdict + fail-closed escalate"
```

---

## Task 14 — Refactor `diagnose.ts` to call `runModel` (worker role, session resume)

`runDiagnosis` currently calls `runClaude` with `cfg.workerModel` and `resumeSessionId`. Change its signature to accept `RuntimeConfig`, call `runModel({ role: "worker", resumeSessionId, … })`. Resume only meaningfully threads for Claude (others run fresh — documented limitation, already true in the chat for Gemini). On a fail-closed result, throw (preserving `runDiagnosis`'s "rejects on model/exec failure" contract noted in its doc comment, so the caller replies with an error rather than silence).

**Files:**
- Modify: `agent/src/diagnose.ts` (import line 1; `runDiagnosis` signature + body lines 39-53)
- Modify (test): no existing `diagnose.test.ts`; create `agent/src/diagnose.test.ts`

**Steps:**

- [ ] Write the failing test `agent/src/diagnose.test.ts`:
```ts
import { describe, expect, test, vi, afterEach } from "vitest";
import { runDiagnosis } from "./diagnose.js";
import * as runModelMod from "./runModel.js";
import type { RuntimeConfig } from "./runtimeConfig.js";

function rc(): RuntimeConfig {
  return {
    enabled: true, mode: "auto", silenced: new Set(), signalRecipients: [], signalInbound: false, alertRules: [],
    worker: { provider: "claude", model: "claude-sonnet-4-6" },
    supervisor: { provider: "claude", model: "claude-opus-4-8" },
    limits: { pollIntervalMs: 30000, maxPerResourcePerHour: 3, maxPerNight: 20, maxAttemptsPerIncident: 3, confirmPolls: 2, namespaces: [] },
  } as RuntimeConfig;
}

afterEach(() => vi.restoreAllMocks());

describe("runDiagnosis", () => {
  test("runs the worker role, threads the resume session id, returns text + sessionId", async () => {
    const spy = vi.spyOn(runModelMod, "runModel").mockResolvedValue({ text: "nginx is healthy", costUsd: 0.005, isError: false, sessionId: "sess-9" });
    const out = await runDiagnosis(rc(), "is nginx ok?", "prev-sess");
    const call = spy.mock.calls[0][0];
    expect(call.role).toBe("worker");
    expect(call.resumeSessionId).toBe("prev-sess");
    expect(call.allowedReads).toContain("Bash(kubectl get *)");
    expect(out.text).toBe("nginx is healthy");
    expect(out.sessionId).toBe("sess-9");
  });

  test("throws on a fail-closed result so the caller replies with an error, not silence", async () => {
    vi.spyOn(runModelMod, "runModel").mockResolvedValue({ text: "", costUsd: 0, isError: true, errorMessage: "gemini has no key" });
    await expect(runDiagnosis(rc(), "q")).rejects.toThrow(/gemini has no key/);
  });
});
```

- [ ] Run it, expect FAIL: `npm --prefix agent test -- diagnose`

- [ ] Edit `agent/src/diagnose.ts`. Replace the import (line 1):
```ts
import { runModel } from "./runModel.js";
```
Add the runtime-config import (after `Config`, line 2):
```ts
import type { RuntimeConfig } from "./runtimeConfig.js";
```
Replace `runDiagnosis` (lines 39-53):
```ts
export async function runDiagnosis(
  rc: RuntimeConfig,
  question: string,
  resumeSessionId?: string,
): Promise<DiagnosisOutput> {
  const result = await runModel({
    role: "worker",
    config: rc,
    prompt: question,
    systemPrompt: SYSTEM_PROMPT,
    allowedReads: READ_ONLY_TOOLS,
    resumeSessionId,
    timeoutMs: 150_000,
  });
  if (result.isError) {
    // Reject on failure so the caller can reply with an error rather than silence.
    throw new Error(result.errorMessage ?? "diagnosis failed");
  }
  return { text: result.text, costUsd: result.costUsd, sessionId: result.sessionId ?? "" };
}
```

- [ ] Run it, expect PASS: `npm --prefix agent test -- diagnose`

- [ ] Commit:
```
git add agent/src/diagnose.ts agent/src/diagnose.test.ts
git commit -m "feat(agent): diagnose calls runModel (worker role) with session resume"
```

---

## Task 15 — Update the loop (`index.ts`) call sites to pass the live `RuntimeConfig`

`index.ts` already reads `rc = await readRuntimeConfig(cfg)` each tick (line 104). Update the three call sites that now take `rc` instead of `cfg`: `runWorker` (in `diagnoseConfirmed`, line 191), `runSupervisor` (line 252), and `runDiagnosis` (line 384). `rc` is already in scope at the worker/supervisor sites; the `runDiagnosis` site is inside `handleSignalInbound`, which receives `rc` as a parameter (line 354), so it is in scope there too. No new tests (these are pure wiring changes covered by Tasks 12-14's unit tests; the loop has no unit test today and adding one is out of scope — `index.ts` wires real IO).

**Files:**
- Modify: `agent/src/index.ts` (lines 191, 252, 384)

**Steps:**

- [ ] Edit `agent/src/index.ts` line 191, inside the `diagnoseConfirmed` call — change `runWorker(cfg, [incident])` to:
```ts
      diagnose: (incident) => runWorker(rc, [incident]),
```

- [ ] Edit `agent/src/index.ts` line 252 — change `sup = await runSupervisor(cfg, incident, action, analysis, command);` to:
```ts
        sup = await runSupervisor(rc, incident, action, analysis, command);
```

- [ ] Edit `agent/src/index.ts` line 384, inside `handleSignalInbound`'s `diagnose` handler — change `runDiagnosis(cfg, q, resumeId)` to:
```ts
          diagnose: (q, resumeId) => runDiagnosis(rc, q, resumeId),
```

- [ ] Typecheck the package to confirm the wiring compiles: `npm --prefix agent run typecheck`

- [ ] Run the FULL suite, expect all PASS: `npm --prefix agent test`

- [ ] Commit:
```
git add agent/src/index.ts
git commit -m "feat(agent): loop passes live RuntimeConfig to worker/supervisor/diagnose"
```

---

## Task 16 — Startup self-check: log which provider CLIs are present

A pure-ish module that probes the four CLIs on PATH (`claude`, `codex`, `gemini`, `opencode`) and returns a presence map; `main()` logs it at startup so a misconfigured image is obvious in the logs. Fail-close intent: an absent CLI is logged but does NOT crash the agent (a role using an absent provider already fails closed at run time via `collectJsonlRun`'s ENOENT path → `runModel` error).

**Files:**
- Create: `agent/src/selfCheck.ts`
- Create (test): `agent/src/selfCheck.test.ts`
- Modify: `agent/src/index.ts` (`main()` — call and log the self-check after `loadConfig`, around line 510)

**Steps:**

- [ ] Write the failing test `agent/src/selfCheck.test.ts`:
```ts
import { describe, expect, test } from "vitest";
import { checkCli, formatSelfCheck, type CliPresence } from "./selfCheck.js";

describe("checkCli", () => {
  test("resolves true for a binary that exists (node)", async () => {
    expect(await checkCli("node")).toBe(true);
  });
  test("resolves false for a binary that does not exist", async () => {
    expect(await checkCli("definitely-not-a-real-cli-xyz")).toBe(false);
  });
});

describe("formatSelfCheck", () => {
  test("renders present/absent per provider", () => {
    const presence: CliPresence = { claude: true, codex: false, gemini: true, opencode: false };
    const line = formatSelfCheck(presence);
    expect(line).toMatch(/claude: present/);
    expect(line).toMatch(/codex: absent/);
    expect(line).toMatch(/gemini: present/);
    expect(line).toMatch(/opencode: absent/);
  });
});
```

- [ ] Run it, expect FAIL: `npm --prefix agent test -- selfCheck`

- [ ] Create `agent/src/selfCheck.ts`:
```ts
import { spawn } from "node:child_process";
import type { ProviderId } from "./providers/types.js";

/** Presence of each provider CLI on PATH. */
export type CliPresence = Record<ProviderId, boolean>;

const PROVIDER_BINS: Record<ProviderId, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  opencode: "opencode",
};

/** True iff `name` resolves on the current PATH (via `command -v`). */
export function checkCli(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", `command -v ${name}`], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0 && out.trim().length > 0));
  });
}

/** Probe all four provider CLIs. Never throws — an absent CLI is just false. */
export async function runSelfCheck(): Promise<CliPresence> {
  const ids = Object.keys(PROVIDER_BINS) as ProviderId[];
  const results = await Promise.all(ids.map((id) => checkCli(PROVIDER_BINS[id])));
  const presence = {} as CliPresence;
  ids.forEach((id, i) => (presence[id] = results[i]!));
  return presence;
}

/** One-line human-readable summary for the startup log. */
export function formatSelfCheck(presence: CliPresence): string {
  return (Object.keys(presence) as ProviderId[])
    .map((id) => `${id}: ${presence[id] ? "present" : "absent"}`)
    .join(", ");
}
```

- [ ] Run it, expect PASS: `npm --prefix agent test -- selfCheck`

- [ ] Edit `agent/src/index.ts`. Add the import near the other imports (after line 26's executor import):
```ts
import { runSelfCheck, formatSelfCheck } from "./selfCheck.js";
```
In `main()`, after the existing startup log (line 510, `log(\`starting v${VERSION} …\`)`), add:
```ts
  log(`provider CLI self-check — ${formatSelfCheck(await runSelfCheck())}`);
```

- [ ] Run the FULL suite, expect all PASS: `npm --prefix agent test`

- [ ] Commit:
```
git add agent/src/selfCheck.ts agent/src/selfCheck.test.ts agent/src/index.ts
git commit -m "feat(agent): startup self-check logging which provider CLIs are present"
```

---

## Task 17 — Update the Assistant Dockerfile: install codex/gemini/opencode + guard shim

Extend `agent/Dockerfile` (Alpine/musl base) to install the three new CLIs and ensure the guarded-kubectl shim runs via the compiled `.js`. Codex: musl static binary downloaded from GitHub releases (arch-aware). Gemini: `npm install -g @google/gemini-cli` (Node is already in the image). OpenCode: Bun-built single binary downloaded from its releases (arch-aware). Set `RIGEL_AGENT_GUARD_CMD=node /app/dist/guardedKubectl.js` so the shim uses the compiled entry (no tsx in the production image). This task has no unit test (it is image build config); verification is the build itself plus the runtime self-check from Task 16.

**Files:**
- Modify: `agent/Dockerfile` (runtime stage, after the Claude install at lines 28-30; add an ENV before `USER node`)

**Steps:**

- [ ] Edit `agent/Dockerfile`. After the Claude Code install block (line 30, `RUN npm install -g @anthropic-ai/claude-code`), add the three provider installs:
```dockerfile
# Codex CLI — musl static binary from GitHub releases (arch-aware). The agent's
# codex bridge shells `codex exec --json` authenticated via CODEX_API_KEY.
RUN apk add --no-cache --virtual .codex-dl curl tar \
 && case "$(uname -m)" in \
      x86_64)  CODEX_ARCH=x86_64-unknown-linux-musl ;; \
      aarch64) CODEX_ARCH=aarch64-unknown-linux-musl ;; \
      *)       CODEX_ARCH=x86_64-unknown-linux-musl ;; \
    esac \
 && curl -fsSL -o /tmp/codex.tar.gz "https://github.com/openai/codex/releases/latest/download/codex-${CODEX_ARCH}.tar.gz" \
 && tar -xzf /tmp/codex.tar.gz -C /usr/local/bin \
 && rm -f /tmp/codex.tar.gz \
 && chmod +x /usr/local/bin/codex \
 && apk del .codex-dl

# Gemini CLI — npm global (Node is already in the image). The gemini bridge shells
# `gemini -o stream-json --approval-mode yolo` authenticated via GEMINI_API_KEY.
RUN npm install -g @google/gemini-cli

# OpenCode CLI — Bun-built single binary from GitHub releases (arch-aware). The
# opencode bridge shells `opencode run --format json` authenticated via
# OPENCODE_AUTH_CONTENT / OPENCODE_API_KEY.
RUN apk add --no-cache --virtual .oc-dl curl unzip \
 && case "$(uname -m)" in \
      x86_64)  OC_ARCH=linux-x64 ;; \
      aarch64) OC_ARCH=linux-arm64 ;; \
      *)       OC_ARCH=linux-x64 ;; \
    esac \
 && curl -fsSL -o /tmp/opencode.zip "https://github.com/sst/opencode/releases/latest/download/opencode-${OC_ARCH}.zip" \
 && unzip -o /tmp/opencode.zip -d /usr/local/bin \
 && rm -f /tmp/opencode.zip \
 && chmod +x /usr/local/bin/opencode \
 && apk del .oc-dl
```

- [ ] Edit `agent/Dockerfile`. Before `USER node` (line 41), add the guard-shim runner env so the shim uses the compiled entry (no tsx in production):
```dockerfile
# The guarded-kubectl shim (agent/src/guardedKubectl.ts → dist/guardedKubectl.js)
# is exec'd by the non-Claude bridges. In the production image there is no tsx, so
# point the shim's runner at the compiled .js (mirrors RIGEL_GUARD_CMD in the chat).
ENV RIGEL_AGENT_GUARD_CMD="node /app/dist/guardedKubectl.js"
```

- [ ] Verify the build is well-formed (lint the Dockerfile syntax by attempting a build IF docker is available; otherwise this is the human's live-verification step — note that the dev machine has no Docker per the project memory). Document in the commit that the image build + runtime self-check is the verification:
```
git add agent/Dockerfile
git commit -m "build(agent): install codex/gemini/opencode CLIs + guard-shim runner env"
```

- [ ] Final full-suite check to close the plan: `npm --prefix agent test` — expect ALL tests green (existing + the new ones from Tasks 1-16). Also `npm --prefix agent run typecheck`.

---

## Done criteria

- `npm --prefix agent test` is all green: the original suite (claude/supervisor/runtimeConfig/etc.) plus the 14 new test files added here.
- `npm --prefix agent run typecheck` passes.
- Default Claude config behavior is unchanged: with `assistant-config` having no role keys, `worker = claude/claude-sonnet-4-6`, `supervisor = claude/claude-opus-4-8`, reading `CLAUDE_CODE_OAUTH_TOKEN`.
- A role pointed at a provider with no credential fails closed with a clear message; an absent CLI fails closed at run time and is logged at startup; a malformed non-Claude supervisor verdict reprompts once then fails closed to escalate.
- The image installs codex/gemini/opencode and the guard-shim runner env (live image-build + in-cluster verification is the human's follow-up, per the no-live-mutation policy).
