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
];

export interface ChatEvent {
  type: "thinking" | "text" | "done" | "error" | "session";
  text?: string;
  /** Present on `session` events — the CLI session id (system init line). */
  sessionId?: string;
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

export async function* runClaude(
  prompt: string,
  context: string | null,
  signal?: AbortSignal,
  opts?: { model?: string; effort?: string },
): AsyncGenerator<ChatEvent> {
  const argv = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose"];
  // Teach the model the action/question button contract (parity with Swift) and
  // block AskUserQuestion (no UI here — it uses ```question blocks instead).
  argv.push("--append-system-prompt", systemPrompt(context));
  argv.push("--disallowedTools", "AskUserQuestion");
  // Apply the composer's model/effort selection as launch flags (validated so a
  // bad value can't inject arbitrary args or break the CLI).
  if (opts?.model && ALLOWED_MODELS.has(opts.model)) argv.push("--model", opts.model);
  if (opts?.effort && ALLOWED_EFFORTS.has(opts.effort)) argv.push("--effort", opts.effort);
  for (const tool of READ_ONLY_ALLOWLIST) {
    argv.push("--allowedTools", tool);
  }

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
      if (ev.type === "system" && ev.subtype === "init" && typeof ev.session_id === "string") {
        yield { type: "session", sessionId: ev.session_id };
      } else if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
        for (const block of ev.message.content) {
          if (block.type === "text") yield { type: "text", text: block.text };
          else if (block.type === "thinking") yield { type: "thinking", text: block.thinking };
        }
      } else if (ev.type === "result") {
        yield { type: "done" };
      }
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
