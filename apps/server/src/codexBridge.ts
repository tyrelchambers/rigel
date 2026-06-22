// Codex (OpenAI) chat runner — the non-Claude sibling of claudeBridge.ts.
//
// Mirrors claudeBridge's STRUCTURE: a pure `buildCodexArgs`, a pure
// `mapCodexEvent`, and a thin `runCodex` that builds argv + env and delegates the
// subprocess lifecycle to streamAgentProcess.
//
// CLI surface VERIFIED against codex-cli 0.141:
//   - flags: `codex exec --help` (0.141). Note codex exec has NO `-a`/`--ask-for-approval`
//     flag; the approval policy is config-only, so we pass `-c approval_policy=never`
//     (a valid value — see codex-rs/execpolicy/src/decision.rs). The `resume`
//     subcommand is real (`codex exec resume <id>`).
//   - `--json` event schema: codex-rs/exec/src/exec_events.rs (ThreadEvent /
//     ThreadItem). ThreadItem `#[serde(flatten)]`s its `details`, whose tagged enum
//     uses `#[serde(tag = "type", rename_all = "snake_case")]`, so an item serializes
//     FLAT as `{ id, type, ...payload }` — hence `item.type` (not a nested/`item_type`
//     field). Item payloads: agent_message/reasoning carry `text`; command_execution
//     carries `command`, `aggregated_output`, `exit_code`, `status`.
// Still unconfirmed by an actual run: that CODEX_API_KEY authenticates a headless
// `codex exec` end-to-end (needs paid OpenAI auth) — auth only, not the wire format.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { codexAuthEnv } from "./agentConfig";
import { systemPrompt } from "./systemPrompt";
import { provisionGuardBin } from "./guardedKubectl";
import { streamAgentProcess, type ChatEvent } from "./agentProcess";
// Reuse Claude's per-turn options shape: the chat composer sends the SAME opts to
// every runner (model/effort/sessionId). Codex now honors model (via -m), but not
// effort (out of scope). isClaudeModelAlias guards against a stale Claude alias.
import { isClaudeModelAlias, type RunClaudeOpts } from "./claudeBridge";

/**
 * Build the `codex exec` argv for one turn. Pure + exported so it can be unit
 * tested without spawning a subprocess (mirrors buildClaudeArgs).
 *
 * SAFETY MODEL — how "read-only cluster access" is realized for Codex:
 * Codex's built-in `read-only` sandbox blocks NETWORK, so kubectl inside it can't
 * reach the cluster API server at all. So instead we run Codex in workspace-write
 * WITH network enabled, and rely on the guarded-kubectl shim (prepended to PATH in
 * runCodex) to deny cluster mutations — reads pass, writes are steered to an action
 * block. Everything is expressed as `-c` config (NOT the `-s`/`-C` flags), because
 * the `codex exec resume` subcommand accepts `-c`/`-m`/`--json`/`--skip-git-repo-check`
 * but NOT `-s` or `-C` — so the same flag set works for both the fresh and resume forms:
 *  - `-c sandbox_mode=workspace-write`                     : allow fs writes (confined to cwd)
 *  - `-c sandbox_workspace_write.network_access=true`      : let kubectl reach the API server
 *  - `-c approval_policy=never`                            : headless — never block on interactive approval
 *    (codex exec has NO `-a`/`--ask-for-approval` flag in 0.141; the policy is config-only)
 *  - `--skip-git-repo-check`                               : allow running outside a git repo
 * The working dir is set via the child process's cwd (a throwaway temp dir, see
 * runCodex) rather than `-C`, since resume rejects `-C`; workspace-write's writable
 * root IS the cwd, so this confines any writes to the temp dir.
 *
 * Flags verified against codex-cli 0.141 (`codex exec --help`, `codex exec resume
 * --help`); config keys (`sandbox_mode`) verified against the codex source.
 */
export function buildCodexArgs(
  prompt: string,
  context: string | null,
  opts: RunClaudeOpts | undefined,
): string[] {
  // Codex has no append-system-prompt flag (unlike `claude --append-system-prompt`),
  // so we PREPEND our system prompt to the user prompt as a single positional. It
  // teaches the same read-only kubectl + action/question/alert block contract.
  const fullPrompt = `${systemPrompt(context)}\n\n# User request\n${prompt}`;

  // The flag set shared by both the fresh and resume forms — all `-c`/`--json`/
  // `--skip-git-repo-check`/`-m`, every one of which `codex exec resume` accepts too.
  const flags = [
    "--json",
    "-c",
    "sandbox_mode=workspace-write",
    "-c",
    "sandbox_workspace_write.network_access=true",
    "-c",
    "approval_policy=never",
    "--skip-git-repo-check",
  ];

  // Model: Codex takes `-m <model>` (e.g. gpt-5-codex), sent by the agent-aware
  // picker. Skip a BARE Claude alias (opus/sonnet/haiku) — the composer historically
  // sent those to every runner, and they're not Codex models, so passing one would
  // break the CLI. Skipping lets Codex fall back to its configured default instead.
  // Effort stays Codex-out-of-scope (opts.effort is ignored).
  if (opts?.model && !isClaudeModelAlias(opts.model)) {
    flags.push("-m", opts.model);
  }

  if (opts?.sessionId) {
    // Resume form: `codex exec resume <SESSION_ID> [prompt] …` continues the same
    // Codex session (parity with Claude's --resume); the session id sits right after
    // `resume`. The flags above are all resume-accepted (verified against
    // `codex exec resume --help` — resume rejects `-s`/`-C`, which is why we use `-c`).
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
 * Event shape (codex `--json`, per codex-rs/exec/src/exec_events.rs, 0.141):
 *  - {type:"thread.started", thread_id} ........ session id
 *  - {type:"turn.started"} ..................... (ignored)
 *  - {type:"turn.completed", usage} ............ end-of-turn
 *  - {type:"turn.failed", error:{message}} ..... turn error
 *  - {type:"item.started", item} .............. a tool call begins (command_execution)
 *  - {type:"item.completed", item} ............ message / reasoning / tool result
 *  - {type:"error", message} .................. stream-level error
 * An `item` serializes FLAT (ThreadItem flattens its tagged `details`): `{ id, type,
 * ...payload }`. Item types handled: agent_message (text), reasoning (text),
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

  // turn.failed → error (ev.error is a ThreadErrorEvent { message })
  if (ev.type === "turn.failed") {
    const msg = ev.error?.message;
    return [{ type: "error", text: typeof msg === "string" ? msg : stringifyError(ev.error) }];
  }

  // stream-level error → error. Codex retries transient connection failures and
  // emits a "Reconnecting… N/5 …" error for EACH attempt; suppress those so the chat
  // isn't flooded — the final, fatal failure still surfaces via the non-zero exit.
  if (ev.type === "error") {
    const text = typeof ev.message === "string" ? ev.message : stringifyError(ev.message);
    if (/^Reconnecting/i.test(text)) return [];
    return [{ type: "error", text }];
  }

  // item.started / item.completed → per-item-type mapping
  if (ev.type === "item.started" || ev.type === "item.completed") {
    const item = ev.item;
    if (!item || typeof item !== "object") return [];
    // ThreadItem flattens its tagged `details`, so the discriminator is `item.type`
    // (per exec_events.rs). agent_message/reasoning carry `text`; command_execution
    // carries command/aggregated_output/exit_code/status — all flat on the item.
    const itemType = item.type;

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

    const argv = buildCodexArgs(prompt, context, opts);

    // cwd = the throwaway workspace dir: Codex uses its cwd as the working root
    // (we don't pass `-C`, since `codex exec resume` rejects it) and workspace-write's
    // writable root IS the cwd, so any writes are confined here, not the user's repo.
    yield* streamAgentProcess({ argv, env, signal, cwd: workspaceDir, mapEvent: mapCodexEvent });
  } finally {
    // Clean up the throwaway workspace + guard shim even on abort/throw. force:true
    // so a missing dir (already gone) isn't an error.
    await rm(workspaceDir, { recursive: true, force: true });
    if (guardBin) await rm(guardBin, { recursive: true, force: true });
  }
}
