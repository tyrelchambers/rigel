/** Pull fenced action JSON blocks out of an assistant message. */
export function extractActionBlocks(markdown: string): any[] {
  const out: any[] = [];
  const re = /```action\s*\n([\s\S]*?)\n```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) {
    try {
      out.push(JSON.parse(m[1].trim()));
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

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
  type: "thinking" | "text" | "done" | "error";
  text?: string;
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
export async function* runClaude(
  prompt: string,
  context: string | null,
): AsyncGenerator<ChatEvent> {
  const argv = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose"];
  for (const tool of READ_ONLY_ALLOWLIST) {
    argv.push("--allowedTools", tool);
  }

  const proc = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(context ? { KUBECONFIG_CONTEXT: context } : {}) },
  });

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
      if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
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
  if (exitCode !== 0) {
    const errText = await new Response(proc.stderr).text();
    yield { type: "error", text: errText.trim() || `claude exited with code ${exitCode}` };
  }
}
