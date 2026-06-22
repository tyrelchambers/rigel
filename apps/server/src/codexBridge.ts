// Codex (OpenAI) chat runner — the non-Claude sibling of claudeBridge.ts.
//
// Mirrors claudeBridge's STRUCTURE: a pure `buildCodexArgs`, a pure
// `mapCodexEvent`, and a thin `runCodex` that builds argv + env and delegates the
// subprocess lifecycle to streamAgentProcess. The Codex CLI surface used here
// (flags + `--json` event schema) is GROUNDED from the OpenAI docs and the codex
// source, but codex is NOT runnable on this dev machine, so the exact spellings
// are PROVISIONAL.
//
// E2E VERIFICATION CHECKLIST (codex not runnable on dev machine):
// Everything below is grounded from docs/source but UNVERIFIED on a live codex.
// Run a real `codex exec --json` and confirm each item; fix the code where it
// diverges, then delete the inline "PROVISIONAL/verify at e2e" markers.
//   1. exec flags (buildCodexArgs): `exec`, `--json`, `-a never`,
//      `-s workspace-write`, `-c sandbox_workspace_write.network_access=true`,
//      `--skip-git-repo-check`, `-C <dir>` — confirm spellings + that the
//      `sandbox_workspace_write.network_access` TOML key is the right path.
//   2. resume placement: `codex exec resume <SESSION_ID> …` — confirm the resume
//      token sits right after `exec` (not e.g. a `--resume <id>` flag).
//   3. API-key auth: the env var from agentConfig.codexAuthEnv (CODEX_API_KEY)
//      actually authenticates a headless `codex exec` (no interactive login).
//   4. event TYPE names (mapCodexEvent): `thread.started` (carries thread_id),
//      `turn.started` / `turn.completed` / `turn.failed`, `item.started` /
//      `item.completed`, and stream-level `error` (carries message).
//   5. item TYPES: `agent_message` (text), `reasoning` (text),
//      `command_execution` (command, aggregated_output, exit_code, status).
//   6. item type field spelling: code reads `item.type ?? item.item_type`.
//      Observe the REAL spelling on a live event, then pick one and DELETE the
//      other read (and its tolerance tests/comments).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { codexAuthEnv } from "./agentConfig";
import { systemPrompt } from "./systemPrompt";
import { provisionGuardBin } from "./guardedKubectl";
import { streamAgentProcess, type ChatEvent } from "./agentProcess";
// Reuse Claude's per-turn options shape: the chat composer sends the SAME opts to
// every runner (model/effort/sessionId). Codex ignores model/effort this pass.
import { type RunClaudeOpts } from "./claudeBridge";

/**
 * Build the `codex exec` argv for one turn. Pure + exported so it can be unit
 * tested without spawning a subprocess (mirrors buildClaudeArgs).
 *
 * SAFETY MODEL — how "read-only cluster access" is realized for Codex:
 * Codex's built-in `read-only` sandbox blocks NETWORK, so kubectl inside it can't
 * reach the cluster API server at all. So instead we run Codex in workspace-write
 * WITH network enabled, and rely on the guarded-kubectl shim (prepended to PATH in
 * runCodex) to deny cluster mutations — reads pass, writes are steered to an action
 * block. The flags here implement exactly that:
 *  - `-s workspace-write`                                  : allow fs writes (confined to -C tempdir)
 *  - `-c sandbox_workspace_write.network_access=true`      : let kubectl reach the API server
 *  - `-a never`                                            : headless — never block on interactive approval
 *  - `--skip-git-repo-check` + `-C <workspaceDir>`         : run in a throwaway temp dir, not the user's repo
 *
 * PROVISIONAL — verify these flags at e2e (checklist item 1, top of file).
 */
export function buildCodexArgs(
  prompt: string,
  context: string | null,
  opts: RunClaudeOpts | undefined,
  workspaceDir: string,
): string[] {
  // Codex has no append-system-prompt flag (unlike `claude --append-system-prompt`),
  // so we PREPEND our system prompt to the user prompt as a single positional. It
  // teaches the same read-only kubectl + action/question/alert block contract.
  const fullPrompt = `${systemPrompt(context)}\n\n# User request\n${prompt}`;

  // The flag set shared by both the fresh and resume forms. Order matters only for
  // the two leading positionals (`exec` / `resume <id>`) and the trailing prompt;
  // the flags in between are order-independent.
  const flags = [
    "--json",
    "-a",
    "never",
    "-s",
    "workspace-write",
    "-c",
    "sandbox_workspace_write.network_access=true",
    "--skip-git-repo-check",
    "-C",
    workspaceDir,
  ];

  // Deliberately NO `--model`: the composer sends Claude aliases (opus/sonnet/haiku)
  // which are NOT Codex models, so passing them would break the CLI. Codex uses its
  // configured default instead, and opts.model/opts.effort are ignored this pass.
  // TODO(follow-up): a per-agent model picker so Codex can take real Codex model ids.

  if (opts?.sessionId) {
    // Resume form: `codex exec resume <SESSION_ID> [prompt] --json …` continues the
    // same Codex session (parity with Claude's --resume). The resume token goes right
    // after `exec`. PROVISIONAL placement — verify at e2e (checklist item 2).
    return ["codex", "exec", "resume", opts.sessionId, ...flags, fullPrompt];
  }
  return ["codex", "exec", ...flags, fullPrompt];
}

/** Truncate long tool output the same way mapClaudeEvent does (~600 chars). */
function truncate(raw: string): string {
  return raw.length > 600 ? raw.slice(0, 600) + "…" : raw;
}

/**
 * Pure mapper: converts ONE parsed `--json` event object from the codex CLI into
 * zero or more ChatEvents. Extracted so it can be unit-tested without a live
 * subprocess (mirrors mapClaudeEvent). Tolerant by design: returns [] for anything
 * unrecognized and guards EVERY field access, because the codex event schema is
 * provisional and may carry fields we don't expect.
 *
 * Event shape (codex `--json`, PROVISIONAL — verify at e2e, checklist items 4-6):
 *  - {type:"thread.started", thread_id} ........ session id
 *  - {type:"turn.started"} ..................... (ignored)
 *  - {type:"turn.completed", usage} ............ end-of-turn
 *  - {type:"turn.failed", error} ............... turn error
 *  - {type:"item.started", item} .............. a tool call begins (command_execution)
 *  - {type:"item.completed", item} ............ message / reasoning / tool result
 *  - {type:"error", message} .................. stream-level error
 * An `item` carries an id and a type read from `item.type ?? item.item_type`
 * (both spellings are tolerated; checklist item 6 says pick one once observed).
 * Item types handled: agent_message (text), reasoning (text),
 * command_execution (command + aggregated_output/exit_code/status).
 * Other item types (file_change/mcp_tool_call/web_search/todo_list) are ignored.
 */
export function mapCodexEvent(ev: any): ChatEvent[] {
  if (!ev || typeof ev !== "object") return [];

  // thread.started → session id
  if (ev.type === "thread.started" && typeof ev.thread_id === "string") {
    return [{ type: "session", sessionId: ev.thread_id }];
  }

  // turn.completed → done (end-of-stream signal, parity with claude's "result")
  if (ev.type === "turn.completed") return [{ type: "done" }];

  // turn.failed → error (stringify the structured error object)
  if (ev.type === "turn.failed") {
    return [{ type: "error", text: stringifyError(ev.error) }];
  }

  // stream-level error → error
  if (ev.type === "error") {
    return [{ type: "error", text: typeof ev.message === "string" ? ev.message : stringifyError(ev.message) }];
  }

  // item.started / item.completed → per-item-type mapping
  if (ev.type === "item.started" || ev.type === "item.completed") {
    const item = ev.item;
    if (!item || typeof item !== "object") return [];
    // Read the item type from either spelling — tolerate both rather than guess
    // (checklist item 6: pick the real one once observed, delete the other).
    const itemType = item.type ?? item.item_type;

    if (itemType === "agent_message") {
      // Assistant prose. Emit on completion (the item carries the full text then).
      if (ev.type === "item.completed" && typeof item.text === "string") {
        return [{ type: "text", text: item.text }];
      }
      return [];
    }

    if (itemType === "reasoning") {
      // Model reasoning → thinking. Emit on completion (full text available).
      if (ev.type === "item.completed" && typeof item.text === "string") {
        return [{ type: "thinking", text: item.text }];
      }
      return [];
    }

    if (itemType === "command_execution") {
      if (ev.type === "item.started") {
        // The shell call begins: surface it as a tool event so the panel shows the
        // command live (parity with claude's tool_use). toolName is "shell" — Codex
        // runs commands via its shell tool, not a named "Bash" tool.
        return [
          {
            type: "tool",
            toolId: item.id,
            toolName: "shell",
            command: typeof item.command === "string" ? item.command : undefined,
            inputJSON: JSON.stringify(item),
          },
        ];
      }
      // item.completed: the command finished — emit its result.
      const exitCode = item.exit_code ?? 0;
      const isError = exitCode !== 0 || item.status === "failed";
      const rawOutput = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
      return [
        {
          type: "toolResult",
          toolId: item.id,
          isError,
          output: truncate(rawOutput),
        },
      ];
    }

    // file_change / mcp_tool_call / web_search / todo_list and anything else: ignore.
    return [];
  }

  // turn.started and any other event type → nothing.
  return [];
}

/** Best-effort stringify of a structured codex error (object or primitive). */
function stringifyError(err: any): string {
  if (err == null) return "Codex turn failed";
  if (typeof err === "string") return err;
  if (typeof err.message === "string") return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Stream a single prompt through the codex CLI in `--json` mode.
 *
 * Provisions a throwaway workspace dir (Codex runs there, not the user's repo) and
 * the guarded-kubectl shim dir (prepended to PATH so every kubectl/helm the agent
 * execs is the read-only-enforcing wrapper). Both temp dirs are removed in a
 * `finally` so an abort or throw can't leak them. The spawn/stream/abort lifecycle
 * is shared with the other runners via streamAgentProcess; codexBridge owns only
 * the argv/env build and the codex-specific JSON→ChatEvent mapping.
 */
export async function* runCodex(
  prompt: string,
  context: string | null,
  signal?: AbortSignal,
  opts?: RunClaudeOpts,
): AsyncGenerator<ChatEvent> {
  const workspaceDir = await mkdtemp(join(tmpdir(), "rigel-codex-"));
  // guardBin is provisioned INSIDE the try so a throw from provisionGuardBin (e.g.
  // kubectl not on PATH) still hits the finally that removes workspaceDir — otherwise
  // the workspace temp dir would leak. guardBin is only removed if it was created.
  let guardBin: string | undefined;
  try {
    guardBin = await provisionGuardBin();

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...(context ? { KUBECONFIG_CONTEXT: context } : {}),
      ...(await codexAuthEnv()),
      // Guard shim FIRST on PATH so kubectl/helm (and any child like `sh -c …`)
      // resolve to the read-only-enforcing wrappers, not the real binaries.
      PATH: `${guardBin}${path.delimiter}${process.env.PATH ?? ""}`,
    };

    const argv = buildCodexArgs(prompt, context, opts, workspaceDir);

    yield* streamAgentProcess({ argv, env, signal, mapEvent: mapCodexEvent });
  } finally {
    // Clean up the throwaway workspace + guard shim even on abort/throw. force:true
    // so a missing dir (already gone) isn't an error.
    await rm(workspaceDir, { recursive: true, force: true });
    if (guardBin) await rm(guardBin, { recursive: true, force: true });
  }
}
