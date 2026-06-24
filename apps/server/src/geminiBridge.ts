// Gemini (Google) chat runner — the sibling of codexBridge.ts/opencodeBridge.ts
// for the gemini-cli.
//
// Mirrors codexBridge's STRUCTURE: a pure `buildGeminiArgs`, a pure
// `mapGeminiEvent`, and a thin `runGemini` that builds argv + env and delegates the
// subprocess lifecycle to streamAgentProcess.
//
// CLI surface VERIFIED against gemini-cli 0.27.3 (`gemini --help`) + its source
// (packages/core/src/output/types.ts):
//   - Headless: `gemini -p "<prompt>" -o stream-json` → newline-delimited JSON
//     events on stdout.
//   - `-m, --model <model>`; `--approval-mode yolo` auto-approves all tools, so
//     kubectl runs unattended — the guarded-kubectl shim (prepended to PATH in
//     runGemini) then denies cluster mutations, the same model as codex/opencode.
//     We do NOT use `-s`/sandbox (it would block kubectl's network access).
//   - Auth: GEMINI_API_KEY env (API key) OR Google OAuth login stored at
//     ~/.gemini/oauth_creds.json.
//   - stream-json event schema (JsonStreamEvent, exact field names):
//       {type:"init", session_id, model, timestamp}
//       {type:"message", role:"user"|"assistant", content, delta?}
//       {type:"tool_use", tool_name, tool_id, parameters}
//       {type:"tool_result", tool_id, status:"success"|"error", output?, error?:{message}}
//       {type:"error", severity:"warning"|"error", message}
//       {type:"result", status:"success"|"error", error?:{message}, stats?}
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { geminiAuthEnv } from "./agentConfig";
import { systemPrompt } from "./systemPrompt";
import { provisionGuardBin } from "./guardedKubectl";
import { streamAgentProcess, type ChatEvent } from "./agentProcess";
// Reuse Claude's per-turn options shape: the chat composer sends the SAME opts to
// every runner (model/effort/sessionId). Gemini honors model (via -m) but not
// effort. isClaudeModel guards against a stale Claude selection.
import { isClaudeModel, type RunClaudeOpts } from "./claudeBridge";

/**
 * Build the `gemini` argv for one turn. Pure + exported so it can be unit tested
 * without spawning a subprocess (mirrors buildCodexArgs).
 *
 * SAFETY MODEL — how "read-only cluster access" is realized for Gemini:
 * `--approval-mode yolo` auto-approves every tool so the headless run never stalls
 * (kubectl reads run unattended). We do NOT pass `-s`/sandbox: its sandbox blocks
 * network, so kubectl couldn't reach the cluster API server. Cluster MUTATIONS are
 * denied by the guarded-kubectl shim prepended to PATH in runGemini — exactly like
 * the codex/opencode runners.
 *
 * NO `-r`/resume this pass: gemini's `-r` resumes by index/"latest" and is per-cwd,
 * which doesn't map to our opaque sessionId + per-turn temp cwd. Gemini ships
 * fresh-per-turn; multi-turn memory is a follow-up.
 */
export function buildGeminiArgs(
  prompt: string,
  context: string | null,
  opts: RunClaudeOpts | undefined,
): string[] {
  // Gemini has no append-system-prompt flag (unlike `claude --append-system-prompt`),
  // so we PREPEND our system prompt to the user prompt as a single positional. It
  // teaches the same read-only kubectl + action/question/alert block contract.
  const fullPrompt = `${systemPrompt(context)}\n\n# User request\n${prompt}`;

  const argv = ["gemini", "-p", fullPrompt, "-o", "stream-json", "--approval-mode", "yolo"];

  // Model: Gemini takes `-m <model>` (e.g. gemini-3-pro), sent by the agent-aware
  // picker. Skip a stale Claude selection (alias like "opus" or a full id like
  // "claude-opus-4-8") — those aren't Gemini models, so passing one would break the
  // CLI. Skipping lets Gemini fall back to its configured default instead.
  if (opts?.model && !isClaudeModel(opts.model)) {
    argv.push("-m", opts.model);
  }

  return argv;
}

/** Truncate long tool output the same way mapCodexEvent does (~600 chars). */
function truncate(raw: string): string {
  return raw.length > 600 ? raw.slice(0, 600) + "…" : raw;
}

/**
 * Pure mapper: converts ONE parsed stream-json event object from the gemini CLI
 * into zero or more ChatEvents. Extracted so it can be unit-tested without a live
 * subprocess (mirrors mapCodexEvent). Tolerant by design: returns [] for anything
 * unrecognized and guards EVERY field access.
 *
 * Event shape (gemini `-o stream-json`, per packages/core/src/output/types.ts):
 *  - {type:"init", session_id, model, timestamp} ........... session id
 *  - {type:"message", role, content, delta?} .............. assistant prose
 *  - {type:"tool_use", tool_name, tool_id, parameters} .... a tool call
 *  - {type:"tool_result", tool_id, status, output?, error?} tool result
 *  - {type:"error", severity, message} ................... stream-level error
 *  - {type:"result", status, error?, stats?} ............. end-of-turn
 */
export function mapGeminiEvent(ev: any): ChatEvent[] {
  if (!ev || typeof ev !== "object") return [];

  // init → session id (only if it's a string).
  if (ev.type === "init") {
    return typeof ev.session_id === "string" ? [{ type: "session", sessionId: ev.session_id }] : [];
  }

  // message → assistant prose. Only assistant messages with string content surface;
  // user messages (echoes of the prompt) are ignored.
  if (ev.type === "message") {
    if (ev.role === "assistant" && typeof ev.content === "string") {
      return [{ type: "text", text: ev.content }];
    }
    return [];
  }

  // tool_use → a tool call. For a shell/bash tool the command is parameters.command.
  if (ev.type === "tool_use") {
    return [
      {
        type: "tool",
        toolId: ev.tool_id,
        toolName: ev.tool_name,
        command: typeof ev.parameters?.command === "string" ? ev.parameters.command : undefined,
        inputJSON: JSON.stringify(ev.parameters ?? {}),
      },
    ];
  }

  // tool_result → the tool's outcome.
  if (ev.type === "tool_result") {
    const rawOutput = ev.output ?? ev.error?.message ?? "";
    return [
      {
        type: "toolResult",
        toolId: ev.tool_id,
        isError: ev.status === "error",
        output: truncate(typeof rawOutput === "string" ? rawOutput : String(rawOutput)),
      },
    ];
  }

  // error → only surface a true error; a "warning" severity must NOT kill the turn.
  if (ev.type === "error") {
    if (ev.severity === "error") {
      return [{ type: "error", text: typeof ev.message === "string" ? ev.message : "Gemini error" }];
    }
    return [];
  }

  // result → end-of-turn. status "error" emits an error before done; else just done.
  // Done comes from this event — runGemini does NOT synthesize it (see the comment there).
  if (ev.type === "result") {
    if (ev.status === "error") {
      const msg = ev.error?.message;
      return [
        { type: "error", text: typeof msg === "string" ? msg : "Gemini turn failed" },
        { type: "done" },
      ];
    }
    return [{ type: "done" }];
  }

  // Any other event type → nothing.
  return [];
}

/**
 * Stream a single prompt through the gemini CLI in stream-json mode.
 *
 * Provisions a throwaway workspace dir (Gemini runs there, not the user's repo) and
 * the guarded-kubectl shim dir (prepended to PATH so every kubectl/helm the agent
 * execs is the read-only-enforcing wrapper). Both temp dirs are removed in a
 * `finally` so an abort or throw can't leak them. The spawn/stream/abort lifecycle
 * is shared with the other runners via streamAgentProcess; geminiBridge owns only
 * the argv/env build and the gemini-specific JSON→ChatEvent mapping.
 *
 * Done is emitted by mapGeminiEvent on the `result` event — we do NOT synthesize it
 * here (unlike opencode, which emits no completion event).
 */
export async function* runGemini(
  prompt: string,
  context: string | null,
  signal?: AbortSignal,
  opts?: RunClaudeOpts,
): AsyncGenerator<ChatEvent> {
  const workspaceDir = await mkdtemp(join(tmpdir(), "rigel-gemini-"));
  // guardBin is provisioned INSIDE the try so a throw from provisionGuardBin (e.g.
  // kubectl not on PATH) still hits the finally that removes workspaceDir — otherwise
  // the workspace temp dir would leak. guardBin is only removed if it was created.
  let guardBin: string | undefined;
  try {
    guardBin = await provisionGuardBin();

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...(context ? { KUBECONFIG_CONTEXT: context } : {}),
      ...(await geminiAuthEnv()),
      // Guard shim FIRST on PATH so kubectl/helm (and any child like `sh -c …`)
      // resolve to the read-only-enforcing wrappers, not the real binaries.
      PATH: `${guardBin}${path.delimiter}${process.env.PATH ?? ""}`,
    };

    const argv = buildGeminiArgs(prompt, context, opts);

    // cwd = the throwaway workspace dir: Gemini runs there, not the user's repo.
    yield* streamAgentProcess({ argv, env, signal, cwd: workspaceDir, mapEvent: mapGeminiEvent });
  } finally {
    // Clean up the throwaway workspace + guard shim even on abort/throw. force:true
    // so a missing dir (already gone) isn't an error.
    await rm(workspaceDir, { recursive: true, force: true });
    if (guardBin) await rm(guardBin, { recursive: true, force: true });
  }
}
