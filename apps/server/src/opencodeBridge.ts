// OpenCode chat runner — the sibling of codexBridge.ts for the OpenCode CLI.
//
// Mirrors codexBridge's STRUCTURE: a pure `buildOpencodeArgs`, a pure
// `mapOpencodeEvent`, and a thin `runOpencode` that builds argv + env and delegates
// the subprocess lifecycle to streamAgentProcess. Unlike codex, the OpenCode CLI
// surface here is GROUNDED against OpenCode v1.17.9 + its source (the `--format json`
// `emit(type, data)` writer that prints `{ type, timestamp, sessionID, ...data }` per
// line), so the flag + event spellings are NOT provisional.
//
// SAFETY MODEL — how "read-only cluster access" is realized for OpenCode:
// OpenCode has no built-in sandbox; it gates tools via a project `opencode.json`
// `permission` object ("allow" | "ask" | "deny"). runOpencode writes a config into
// the throwaway run dir that ALLOWS the bash tool (so kubectl reads run unattended)
// but DENIES edit/webfetch/websearch, and crucially uses no "ask" (which would stall
// a headless run). Cluster MUTATIONS are still denied by the guarded-kubectl shim
// prepended to PATH in runOpencode (commandPolicy.classifyCommand) — exactly like the
// codex runner. So: bash allowed → guard shim lets reads through, denies writes.
//
// E2E VERIFICATION CHECKLIST (run against a real `opencode` once available):
//   1. `opencode run --dir <dir>` actually LOADS `<dir>/opencode.json` and honors its
//      `permission` block (bash allowed, edit/webfetch/websearch denied, no "ask"
//      prompt stalls the headless run). This is the one item to confirm live.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { opencodeAuthEnv } from "./agentConfig";
import { systemPrompt } from "./systemPrompt";
import { provisionGuardBin } from "./guardedKubectl";
import { streamAgentProcess, type ChatEvent } from "./agentProcess";
// Reuse Claude's per-turn options shape: the chat composer sends the SAME opts to
// every runner (model/effort/sessionId). OpenCode honors model (via -m) and effort
// (via --variant). isClaudeModel guards against a stale Claude selection.
import { isClaudeModel, type RunClaudeOpts } from "./claudeBridge";

/**
 * Reasoning-effort levels exposed for OpenCode via `--variant`. OpenCode variant
 * values are model-specific, so this is the safe common set — an unsupported level
 * falls back to the model's default. Hardcoded; feeds the picker (agentModels) and
 * the buildOpencodeArgs guard.
 */
export const OPENCODE_EFFORTS = new Set(["low", "medium", "high"]);

/**
 * Build the `opencode run` argv for one turn. Pure + exported so it can be unit
 * tested without spawning a subprocess (mirrors buildCodexArgs).
 *
 * Flags (grounded against OpenCode v1.17.9):
 *  - `run`                : the headless one-shot subcommand
 *  - `--format json`      : newline-delimited JSON events on stdout
 *  - `--thinking`         : surface reasoning events (mapped to `thinking`)
 *  - `--dir <runDir>`     : run in a throwaway temp dir (also where opencode.json lives)
 *  - `-s <sessionId>`     : resume a prior session (parity with Claude's --resume)
 *  - `-m <provider/model>`: the model from the agent-aware picker (when present)
 *  - `--variant <level>`  : reasoning effort from the picker (when present)
 * The user message is the trailing positional.
 *
 * Model: OpenCode takes `-m provider/model` (the picker sends an OpenCode id like
 * "anthropic/claude-…"). We SKIP a stale Claude selection (alias like "opus" or a
 * full id like "claude-opus-4-8") — those aren't OpenCode ids, so passing one would
 * break the CLI; skipping lets OpenCode use its configured default.
 */
export function buildOpencodeArgs(
  prompt: string,
  context: string | null,
  opts: RunClaudeOpts | undefined,
  runDir: string,
): string[] {
  // OpenCode has no append-system-prompt flag, so we PREPEND our system prompt to
  // the user prompt as a single positional. It teaches the same read-only kubectl +
  // action/question/alert block contract as the other runners.
  const fullPrompt = `${systemPrompt(context)}\n\n# User request\n${prompt}`;

  // Flags shared by the fresh and resume forms. Order is irrelevant for the flags;
  // the message stays the trailing positional.
  const flags = ["--format", "json", "--thinking", "--dir", runDir];

  // Model: pass `-m <provider/model>` from the picker, but skip a stale Claude
  // selection (see the doc comment) so OpenCode falls back to its own default rather than erroring.
  if (opts?.model && !isClaudeModel(opts.model)) {
    flags.push("-m", opts.model);
  }

  // Effort: OpenCode maps reasoning effort onto `--variant`. Validated against
  // OPENCODE_EFFORTS so a bad/stale value can't inject a flag.
  if (opts?.effort && OPENCODE_EFFORTS.has(opts.effort)) {
    flags.push("--variant", opts.effort);
  }

  if (opts?.sessionId) {
    // Resume form: continue the same OpenCode session (`-s <sessionId>`).
    return ["opencode", "run", ...flags, "-s", opts.sessionId, fullPrompt];
  }
  return ["opencode", "run", ...flags, fullPrompt];
}

/** Truncate long tool output the same way mapCodexEvent does (~600 chars). */
function truncate(raw: string): string {
  return raw.length > 600 ? raw.slice(0, 600) + "…" : raw;
}

/**
 * Pure mapper: converts ONE parsed `--format json` event object from the opencode
 * CLI into zero or more ChatEvents. Extracted so it can be unit-tested without a
 * live subprocess (mirrors mapCodexEvent). Tolerant by design: returns [] for
 * anything unrecognized and guards EVERY field access.
 *
 * Event shape (OpenCode `--format json`, from source — `emit(type, data)` writes
 * `{ type, timestamp, sessionID, ...data }` per line). Handled `type` values:
 *  - "text"        → { part: { text } } ............ assistant prose (text finalized)
 *  - "reasoning"   → { part: { text } } ............ thinking (only with --thinking)
 *  - "tool_use"    → { part: { id, tool, state: { status, input, output, error } } }
 *                    Emitted ONCE per tool when it completes/errors (no separate
 *                    "started" event in json mode), so we synthesize BOTH a `tool`
 *                    and a `toolResult` from the single event.
 *  - "step_start"  → carries sessionID for resume → `session` (harmless if repeated)
 *  - "step_finish" → ignored
 *  - "error"       → { error: { name, data?: { message } } } → `error`
 * Completion is NOT emitted — the stream simply ends on session idle; runOpencode
 * synthesizes the `done` ChatEvent on clean exit. Anything else → [].
 */
export function mapOpencodeEvent(ev: any): ChatEvent[] {
  if (!ev || typeof ev !== "object") return [];

  // text → assistant prose (skip empty).
  if (ev.type === "text") {
    const text = ev.part?.text;
    return typeof text === "string" && text.length > 0 ? [{ type: "text", text }] : [];
  }

  // reasoning → thinking (only present when --thinking is passed; skip empty).
  if (ev.type === "reasoning") {
    const text = ev.part?.text;
    return typeof text === "string" && text.length > 0 ? [{ type: "thinking", text }] : [];
  }

  // tool_use → BOTH a tool call AND its result (the single event carries the
  // completed/errored state). For a bash tool the command is part.state.input.command.
  if (ev.type === "tool_use") {
    const part = ev.part ?? {};
    const state = part.state ?? {};
    const isError = state.status === "error";
    // Prefer the structured output; on error fall back to the error text.
    const rawOutput =
      typeof state.output === "string"
        ? state.output
        : typeof state.error === "string"
          ? state.error
          : "";
    return [
      {
        type: "tool",
        toolId: part.id,
        toolName: part.tool,
        command: typeof state.input?.command === "string" ? state.input.command : undefined,
        inputJSON: JSON.stringify(part),
      },
      {
        type: "toolResult",
        toolId: part.id,
        isError,
        output: truncate(rawOutput),
      },
    ];
  }

  // step_start → carries the session id for resume (harmless if it repeats).
  if (ev.type === "step_start") {
    return typeof ev.sessionID === "string" ? [{ type: "session", sessionId: ev.sessionID }] : [];
  }

  // step_finish → step boundary, nothing to surface.
  if (ev.type === "step_finish") return [];

  // error → session error (prefer the structured message, fall back to the name).
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

  // Any other event type → nothing.
  return [];
}

/**
 * Stream a single prompt through the opencode CLI in `--format json` mode.
 *
 * Runs in a STABLE run dir (OpenCode runs there, not the user's repo) into which it
 * writes an `opencode.json` permission config (bash allowed for read-only kubectl,
 * edit/webfetch/websearch denied, no "ask" so the headless run never stalls). The dir
 * is deliberately fixed rather than per-turn: OpenCode keys session storage by the
 * `--dir` project path, so a fresh directory each turn would make `-s <sessionId>`
 * resume fail with "Session not found". It is NOT removed after a turn — that is what
 * makes multi-turn resume work. The guarded-kubectl shim dir (prepended to PATH so
 * every kubectl/helm the agent execs is the read-only-enforcing wrapper) IS a throwaway
 * removed in `finally` so an abort or throw can't leak it. The spawn/stream/abort
 * lifecycle is shared with the other runners via streamAgentProcess; opencodeBridge
 * owns only the argv/env/config build and the opencode-specific JSON→ChatEvent mapping.
 *
 * OpenCode emits NO completion event (the stream just ends on session idle), so we
 * synthesize a `done` ChatEvent on clean completion. On abort streamAgentProcess
 * already yields `done`; on non-zero exit it yields `error`.
 */
export async function* runOpencode(
  prompt: string,
  context: string | null,
  signal?: AbortSignal,
  opts?: RunClaudeOpts,
): AsyncGenerator<ChatEvent> {
  // STABLE run dir (not a per-turn mkdtemp): OpenCode keys session storage by the
  // `--dir` project path, so a fresh directory each turn makes `-s <sessionId>` resume
  // fail with "Session not found". A fixed path keeps the project — and thus the
  // session — resolvable across turns (parity with claudeBridge's stable cwd). One
  // shared dir is safe: OpenCode isolates by session id within a project.
  const runDir = join(tmpdir(), "rigel-opencode");
  await mkdir(runDir, { recursive: true });
  // Headless permission config: allow everything by default so read-only kubectl runs
  // unattended, then DENY edit/webfetch/websearch (no file edits, no web). No "ask"
  // values — those would stall a headless run. The guard shim still denies cluster
  // mutations on top of the allowed bash tool.
  await writeFile(
    join(runDir, "opencode.json"),
    JSON.stringify({ permission: { "*": "allow", edit: "deny", webfetch: "deny", websearch: "deny" } }),
  );
  // guardBin is provisioned INSIDE the try so a throw from provisionGuardBin (e.g.
  // kubectl not on PATH) still hits the finally that removes runDir — otherwise the
  // run temp dir would leak. guardBin is only removed if it was created.
  let guardBin: string | undefined;
  try {
    guardBin = await provisionGuardBin();

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...(context ? { KUBECONFIG_CONTEXT: context } : {}),
      ...(await opencodeAuthEnv()),
      // Guard shim FIRST on PATH so kubectl/helm (and any child like `sh -c …`)
      // resolve to the read-only-enforcing wrappers, not the real binaries.
      PATH: `${guardBin}${path.delimiter}${process.env.PATH ?? ""}`,
    };

    const argv = buildOpencodeArgs(prompt, context, opts, runDir);

    yield* streamAgentProcess({ argv, env, signal, mapEvent: mapOpencodeEvent });

    // OpenCode emits no completion event; synthesize `done` on a clean (non-aborted)
    // finish. On abort, streamAgentProcess already yielded `done`.
    if (!signal?.aborted) yield { type: "done" };
  } finally {
    // The run dir is persistent (it holds OpenCode's per-project session state), so it
    // is NOT removed here. Only the guard shim is cleaned up. force:true so a missing
    // dir (already gone) isn't an error.
    if (guardBin) await rm(guardBin, { recursive: true, force: true });
  }
}
