// Action-block parsing lives once in the shared package so the chat panel
// (apps/web) and this bridge decode the fenced ```action JSON identically.
export { extractActionBlocks } from "@helmsman/k8s/src/actionBlocks";
import { effectiveClaudeToken } from "./chatConfig";
import { systemPrompt } from "./systemPrompt";

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
  const hookPath = new URL("./permissionHook.ts", import.meta.url).pathname;
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: `bun ${hookPath}` }],
        },
      ],
    },
  });
}

export function readAllowlist(context: string | null): string[] {
  if (!context) return READ_ONLY_ALLOWLIST;
  const prefixed = READ_ONLY_ALLOWLIST.filter((p) => p.startsWith("Bash(kubectl ")).map(
    (p) => p.replace("Bash(kubectl ", `Bash(kubectl --context ${context} `),
  );
  return [...READ_ONLY_ALLOWLIST, ...prefixed];
}

export interface ChatEvent {
  type: "thinking" | "text" | "done" | "error" | "session" | "tool" | "toolResult";
  text?: string;
  /** Present on `session` events — the CLI session id (system init line). */
  sessionId?: string;
  /** tool/toolResult: the tool_use id (correlates a call with its result). */
  toolId?: string;
  /** tool: tool name, e.g. "Bash". */
  toolName?: string;
  /** tool: extracted Bash command (input.command), when present. */
  command?: string;
  /** tool: extracted Bash description (input.description), when present. */
  description?: string;
  /** tool: JSON.stringify(input), for an expandable raw view. */
  inputJSON?: string;
  /** toolResult: true if the tool errored or was denied. */
  isError?: boolean;
  /** toolResult: short output/stderr/denial text (truncate to ~600 chars). */
  output?: string;
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
/** CLI aliases the picker may send; anything else is ignored (no flag added). */
const ALLOWED_MODELS = new Set(["opus", "sonnet", "haiku"]);
const ALLOWED_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export interface RunClaudeOpts {
  model?: string;
  effort?: string;
  /** Prior CLI session id — passed as `--resume` so the turn continues the same
   * conversation (parity with Swift's ClaudeSession resume). Absent = fresh turn. */
  sessionId?: string;
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
  // Teach the model the action/question button contract (parity with Swift) and
  // block AskUserQuestion (no UI here — it uses ```question blocks instead).
  argv.push("--append-system-prompt", systemPrompt(context));
  argv.push("--disallowedTools", "AskUserQuestion");
  // Denylist permissioning: a PreToolUse hook (commandPolicy) auto-allows every
  // non-mutating Bash command — so reads run regardless of flag order — and DENIES
  // kubectl/helm cluster mutations, feeding back a reason that steers the model to
  // an approve-and-run `command` action block. The per-pattern read allowlist below
  // stays as a fallback so reads keep working even if the hook ever fails to run.
  argv.push("--settings", permissionHookSettings());
  // Apply the composer's model/effort selection as launch flags (validated so a
  // bad value can't inject arbitrary args or break the CLI).
  if (opts?.model && ALLOWED_MODELS.has(opts.model)) argv.push("--model", opts.model);
  if (opts?.effort && ALLOWED_EFFORTS.has(opts.effort)) argv.push("--effort", opts.effort);
  // Resume the prior session so the model keeps conversation + action-result
  // history across turns. Only when we actually have an id (first turn is fresh).
  if (opts?.sessionId) argv.push("--resume", opts.sessionId);
  for (const tool of readAllowlist(context)) {
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

  // Token: explicit env wins; otherwise the in-app Settings token (persisted to
  // the claude home) is injected so chat works without an env restart.
  const token = await effectiveClaudeToken();
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(context ? { KUBECONFIG_CONTEXT: context } : {}),
  };
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;

  const proc = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  // Stop: aborting kills the claude subprocess; the stdout reader then ends and
  // we exit the turn cleanly (no spurious "exited with code 143" error below).
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

  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      for (const e of mapClaudeEvent(ev)) yield e;
    }
  }

  const exitCode = await proc.exited;
  if (signal) signal.removeEventListener("abort", onAbort);
  if (signal?.aborted) {
    // Interrupted by the user — end the turn quietly, not as an error.
    yield { type: "done" };
    return;
  }
  if (exitCode !== 0) {
    const errText = await new Response(proc.stderr).text();
    yield { type: "error", text: errText.trim() || `claude exited with code ${exitCode}` };
  }
}
