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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { opencodeAuthEnv } from "./agentConfig";
import { systemPrompt } from "./systemPrompt";
import { provisionGuardBin } from "./guardedKubectl";
import { streamAgentProcess, type ChatEvent } from "./agentProcess";
// Reuse Claude's per-turn options shape: the chat composer sends the SAME opts to
// every runner (model/effort/sessionId). OpenCode ignores model/effort this pass.
import { type RunClaudeOpts } from "./claudeBridge";

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
 * The user message is the trailing positional.
 *
 * Deliberately NO `-m`/`--model`: the composer sends Claude aliases (opus/sonnet/
 * haiku) which are NOT OpenCode model ids, so passing them would break the CLI.
 * OpenCode uses the user's configured default model; opts.model/opts.effort are
 * ignored this pass. (TODO follow-up: a per-agent model picker.)
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
 * Provisions a throwaway run dir (OpenCode runs there, not the user's repo) into
 * which it writes an `opencode.json` permission config (bash allowed for read-only
 * kubectl, edit/webfetch/websearch denied, no "ask" so the headless run never
 * stalls), and the guarded-kubectl shim dir (prepended to PATH so every kubectl/helm
 * the agent execs is the read-only-enforcing wrapper). Both temp dirs are removed in
 * a `finally` so an abort or throw can't leak them. The spawn/stream/abort lifecycle
 * is shared with the other runners via streamAgentProcess; opencodeBridge owns only
 * the argv/env/config build and the opencode-specific JSON→ChatEvent mapping.
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
  const runDir = await mkdtemp(join(tmpdir(), "rigel-opencode-"));
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
    // Clean up the throwaway run dir + guard shim even on abort/throw. force:true so a
    // missing dir (already gone) isn't an error.
    await rm(runDir, { recursive: true, force: true });
    if (guardBin) await rm(guardBin, { recursive: true, force: true });
  }
}
