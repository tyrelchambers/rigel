// Action-block parsing lives once in the shared package so the chat panel
// (apps/web) and this bridge decode the fenced ```action JSON identically.
export { extractActionBlocks } from "@rigel/k8s/src/actionBlocks";
import { claudeAuthEnv } from "./agentConfig";
import { systemPrompt } from "./systemPrompt";
import { streamAgentProcess, type ChatEvent } from "./agentProcess";
import { fileURLToPath } from "node:url";

// ChatEvent is the shared event type for all agent runners; it lives in
// agentProcess.ts now. Re-export it so existing importers (runAgent.ts, etc.)
// keep importing it from here unchanged.
export type { ChatEvent } from "./agentProcess";

const READ_ONLY_ALLOWLIST = [
  "Bash(kubectl get *)",
  "Bash(kubectl describe *)",
  "Bash(kubectl logs *)",
  "Bash(kubectl top *)",
  "Bash(kubectl events *)",
  "Bash(kubectl explain *)",
  "Bash(kubectl version*)",
  "Bash(kubectl cluster-info*)",
  "Bash(kubectl api-resources*)",
  "Bash(kubectl api-versions*)",
  "Bash(kubectl auth can-i *)",
  "Bash(kubectl config get-contexts*)",
  "Bash(kubectl config current-context*)",
  "Bash(kubectl config view*)",
  // Read-only text filters. Claude Code checks EACH subcommand of a pipe/&&
  // chain independently, and only auto-allows a small built-in read-only set
  // (grep/head/tail/jq/wc/…). The model routinely post-processes kubectl output
  // with these, so without them a command like `kubectl get … | awk …` gets the
  // WHOLE pipe denied — surfacing as a bogus "kubectl get needs approval".
  // These are pure stream processors: they can't mutate the cluster (kubectl
  // write verbs stay un-allowlisted, so `… | kubectl apply` is still denied and
  // gated behind the action-button confirm). Deliberately excludes xargs/sh/
  // bash/eval/tee/dd — anything that could invoke a write or a cluster mutation.
  "Bash(awk *)",
  "Bash(sed *)",
  "Bash(cut *)",
  "Bash(sort *)",
  "Bash(uniq *)",
  "Bash(column *)",
  "Bash(tr *)",
  "Bash(jq *)",
  "Bash(yq *)",
  // The model habitually appends an exit-code probe like `… ; echo "exit: $?"`
  // or interleaves separators like `… ; echo "---PG---"; …`. Each segment of a
  // `;`/`&&`/`|` chain is permission-checked independently, so an un-allowlisted
  // `echo` got the WHOLE compound command denied — surfacing as a bogus approval
  // prompt on a pure read. `echo`/`cat` only emit to stdout and can't mutate the
  // cluster (kubectl write verbs stay un-allowlisted and gated behind the action
  // confirm). A `>` redirect would still be flagged by the CLI as a separate op.
  "Bash(echo *)",
  "Bash(cat *)",
];

/**
 * The system prompt tells the model to "always pass `--context <ctx>`", and it
 * often writes `kubectl --context <ctx> get …` — with the flag BEFORE the verb.
 * The base patterns above only match `kubectl get …` (verb adjacent to kubectl),
 * so every context-prefixed read was being DENIED. Since we know the selected
 * context, emit the context-prefixed variant of each kubectl pattern too, so the
 * read is allowlisted regardless of where the model puts `--context`. Filter
 * patterns (awk/sed/…) are left untouched (they don't take `--context`).
 */
/**
 * Inline `--settings` JSON registering the PreToolUse Bash permission hook
 * (apps/server/src/permissionHook.ts, resolved next to this file so it works both
 * in the container and in local dev). The hook classifies each command and
 * allows reads / denies cluster mutations — see commandPolicy.ts.
 */
export function permissionHookSettings(): string {
  // Dev/Docker default: run the .ts hook via Node + tsx, resolved next to this
  // bundle. The packaged desktop app has NO node/tsx on PATH, so it sets
  // HELMSMAN_HOOK_CMD to run the prebuilt .mjs hook via Electron-as-node
  // (electron --run-as-node). Honoring the env override there keeps dev/Docker
  // on the default while letting the packaged app inject a self-contained command.
  const hookPath = fileURLToPath(new URL("./permissionHook.ts", import.meta.url));
  const command = process.env.HELMSMAN_HOOK_CMD || `node --import tsx ${hookPath}`;
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command }],
        },
      ],
    },
  });
}

export function readAllowlist(contexts: string[]): string[] {
  const prefixed = contexts.flatMap((ctx) =>
    READ_ONLY_ALLOWLIST.filter((p) => p.startsWith("Bash(kubectl ")).map((p) =>
      p.replace("Bash(kubectl ", `Bash(kubectl --context ${ctx} `),
    ),
  );
  return [...READ_ONLY_ALLOWLIST, ...prefixed];
}

/**
 * Pure mapper: converts ONE parsed stream-json object from the claude CLI into
 * zero or more ChatEvents. Extracted so it can be unit-tested without a live
 * subprocess.
 */
export function mapClaudeEvent(ev: any): ChatEvent[] {
  if (!ev || typeof ev !== "object") return [];

  // system init → session id
  if (ev.type === "system" && ev.subtype === "init" && typeof ev.session_id === "string") {
    return [{ type: "session", sessionId: ev.session_id }];
  }

  // assistant message → text / thinking / tool_use blocks
  if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
    const events: ChatEvent[] = [];
    for (const block of ev.message.content) {
      if (block.type === "text") {
        events.push({ type: "text", text: block.text });
      } else if (block.type === "thinking") {
        events.push({ type: "thinking", text: block.thinking });
      } else if (block.type === "tool_use") {
        events.push({
          type: "tool",
          toolId: block.id,
          toolName: block.name,
          command: block.input?.command,
          description: block.input?.description,
          inputJSON: JSON.stringify(block.input ?? {}),
        });
      }
    }
    return events;
  }

  // user message → tool_result blocks
  if (ev.type === "user" && Array.isArray(ev.message?.content)) {
    const events: ChatEvent[] = [];
    for (const block of ev.message.content) {
      if (block.type === "tool_result") {
        let raw: string;
        if (typeof block.content === "string") {
          raw = block.content;
        } else if (Array.isArray(block.content)) {
          raw = block.content.map((c: any) => (typeof c === "object" && c.text ? c.text : "")).join("\n");
        } else {
          raw = "";
        }
        const output = raw.length > 600 ? raw.slice(0, 600) + "…" : raw;
        events.push({
          type: "toolResult",
          toolId: block.tool_use_id,
          isError: block.is_error === true,
          output,
        });
      }
    }
    return events;
  }

  // result → permission denials (as toolResult isError) then done
  if (ev.type === "result") {
    const events: ChatEvent[] = [];
    for (const d of ev.permission_denials ?? []) {
      events.push({
        type: "toolResult",
        toolId: d.tool_use_id,
        isError: true,
        output: "Denied — not pre-approved (needs a confirm button, or isn't in the read allowlist)",
      });
    }
    events.push({ type: "done" });
    return events;
  }

  return [];
}

/**
 * Stream a single prompt through the claude CLI in stream-json mode.
 *
 * Flags rationale (derived from agent/src/claude.ts):
 *  - agent/src/claude.ts uses --output-format json (batch) and collects the
 *    full stdout before parsing. For streaming we switch to stream-json so
 *    each content event arrives as a newline-delimited JSON line while the
 *    process is still running.
 *  - -p <prompt> is the same pattern the agent uses.
 *  - --allowedTools is repeated per-tool (same as agent's loop), but the CLI
 *    also accepts a comma-joined single flag; repeated flags are more robust.
 *  - No --input-format needed: we supply the prompt via -p, not stdin.
 *  - No --model flag here: the bridge uses whatever the user's default model
 *    is (set via claude config), keeping it decoupled from agent model choice.
 *
 * Event shape (claude CLI stream-json, confirmed against Claude Code SDK docs):
 *  - { type: "assistant", message: { content: [ { type: "text", text }, ... ] } }
 *    -- incremental assistant text / thinking blocks mid-stream.
 *  - { type: "result", ... } -- final summary; signals end-of-stream.
 *  - Other types (system, user, tool_use, tool_result) are silently skipped.
 */
/**
 * The full Claude model ids the picker advertises — single source of truth for the
 * Claude model list shown in BOTH the chat composer and the Assistant Agents picker
 * (agentModels.ts surfaces this set). Full ids (not the bare opus/sonnet/haiku
 * aliases) so a selection matches the full-id defaults the UI ships and the in-cluster
 * agent runs (see providerMeta DEFAULT_WORKER/SUPERVISOR + agent/src/providers/claude).
 * `claude --model` accepts these full ids directly. Insertion order is preserved.
 * Update when a new Claude model ships — there is no `claude` CLI command to list models.
 */
export const ALLOWED_MODELS = new Set([
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-fable-5",
]);

/**
 * Bare "latest" aliases the `claude` CLI also accepts for --model. The picker uses
 * full ids, but a stored/legacy selection may still carry one of these, so we keep
 * honoring them rather than silently dropping a valid model.
 */
const CLAUDE_ALIASES = new Set(["opus", "sonnet", "haiku", "fable"]);

export const ALLOWED_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/**
 * True when `model` is a Claude model string the `claude` CLI accepts for --model:
 * one of our advertised full ids or a bare latest-alias. Used (a) to gate the
 * --model flag in buildClaudeArgs, and (b) by the codex/gemini/opencode bridges to
 * SKIP a stale Claude selection rather than passing it as their own `-m` (which would
 * error, e.g. on "opus" / "claude-opus-4-8"), falling back to their configured default.
 * Shared so the rule stays in one place.
 */
export function isClaudeModel(model: string): boolean {
  return ALLOWED_MODELS.has(model) || CLAUDE_ALIASES.has(model);
}

export interface RunClaudeOpts {
  model?: string;
  effort?: string;
  /** Prior CLI session id — passed as `--resume` so the turn continues the same
   * conversation (parity with Swift's ClaudeSession resume). Absent = fresh turn. */
  sessionId?: string;
  /** Contexts the model may run READ-ONLY kubectl against this turn (fan-out).
   *  Active-first; defaults to just the active context. */
  readContexts?: string[];
}

/**
 * Build the `claude` CLI argv for one turn. Pure + exported so it can be unit
 * tested without spawning a subprocess (mirrors Swift's `buildArguments`).
 */
export function buildClaudeArgs(
  prompt: string,
  context: string | null,
  opts?: RunClaudeOpts,
): string[] {
  const argv = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose"];
  const readContexts = opts?.readContexts ?? (context ? [context] : []);
  // Teach the model the action/question button contract (parity with Swift) and
  // block AskUserQuestion (no UI here — it uses ```question blocks instead).
  argv.push("--append-system-prompt", systemPrompt(context, readContexts));
  argv.push("--disallowedTools", "AskUserQuestion");
  // Denylist permissioning: a PreToolUse hook (commandPolicy) auto-allows every
  // non-mutating Bash command — so reads run regardless of flag order — and DENIES
  // kubectl/helm cluster mutations, feeding back a reason that steers the model to
  // an approve-and-run `command` action block. The per-pattern read allowlist below
  // stays as a fallback so reads keep working even if the hook ever fails to run.
  argv.push("--settings", permissionHookSettings());
  // Apply the composer's model/effort selection as launch flags (validated so a
  // bad value can't inject arbitrary args or break the CLI).
  if (opts?.model && isClaudeModel(opts.model)) argv.push("--model", opts.model);
  if (opts?.effort && ALLOWED_EFFORTS.has(opts.effort)) argv.push("--effort", opts.effort);
  // Resume the prior session so the model keeps conversation + action-result
  // history across turns. Only when we actually have an id (first turn is fresh).
  if (opts?.sessionId) argv.push("--resume", opts.sessionId);
  for (const tool of readAllowlist(readContexts)) {
    argv.push("--allowedTools", tool);
  }
  return argv;
}

export async function* runClaude(
  prompt: string,
  context: string | null,
  signal?: AbortSignal,
  opts?: RunClaudeOpts,
): AsyncGenerator<ChatEvent> {
  const argv = buildClaudeArgs(prompt, context, opts);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(context ? { KUBECONFIG_CONTEXT: context } : {}),
    ...(await claudeAuthEnv()),
  };

  // The spawn/stream/abort lifecycle is shared with other agent runners (codex,
  // …) via streamAgentProcess; claudeBridge owns only the argv/env build and the
  // claude-specific JSONL→ChatEvent mapping.
  yield* streamAgentProcess({ argv, env, signal, mapEvent: mapClaudeEvent });
}
