import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

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

export interface StreamAgentProcessArgs {
  /** Full argv; argv[0] is the binary, argv.slice(1) are its arguments. */
  argv: string[];
  env: Record<string, string>;
  signal?: AbortSignal;
  /** Map ONE parsed JSONL object from stdout to zero+ ChatEvents. */
  mapEvent: (ev: any) => ChatEvent[];
}

/**
 * Shared subprocess streaming harness for agent runners (claude, codex, …).
 *
 * Spawns the given CLI, reads newline-delimited JSON from stdout, maps each line
 * to ChatEvents via the caller's `mapEvent`, and handles stderr/exit/abort. The
 * per-agent argv/env build and JSONL→ChatEvent mapping stay with each runner;
 * this owns only the spawn/stream/abort lifecycle so every runner shares it.
 */
export async function* streamAgentProcess({
  argv,
  env,
  signal,
  mapEvent,
}: StreamAgentProcessArgs): AsyncGenerator<ChatEvent> {
  const proc = spawn(argv[0], argv.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  // Accumulate stderr from spawn time so it's available for the error path even
  // though the stream is consumed live (Node Readables don't replay).
  const stderrChunks: Buffer[] = [];
  proc.stderr!.on("data", (buf: Buffer) => stderrChunks.push(buf));

  // Capture the exit code up front: the "close" event can fire before the
  // stdout reader loop below finishes draining, so awaiting it afterwards would
  // hang. This promise latches the code regardless of ordering. An "error"
  // (e.g. the binary not on PATH → ENOENT, where "close" never fires) resolves
  // it too, with the message captured as stderr so the error path surfaces it.
  const exitPromise: Promise<number | null> = new Promise((resolve) => {
    proc.once("close", (code) => resolve(code));
    proc.once("error", (err: Error) => {
      stderrChunks.push(Buffer.from(err.message));
      resolve(-1);
    });
  });

  // Stop: aborting kills the subprocess; the stdout reader then ends and we exit
  // the turn cleanly (no spurious "exited with code 143" error below).
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

  // Newline-delimited JSON: each stdout line is one CLI event object. readline's
  // async iterator pulls lines as the generator's consumer pulls events, and
  // ends when stdout closes (process exit or kill on abort).
  const rl = createInterface({ input: proc.stdout! });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    for (const e of mapEvent(ev)) yield e;
  }

  const exitCode = await exitPromise;
  if (signal) signal.removeEventListener("abort", onAbort);
  if (signal?.aborted) {
    // Interrupted by the user — end the turn quietly, not as an error.
    yield { type: "done" };
    return;
  }
  if (exitCode !== 0) {
    const errText = Buffer.concat(stderrChunks).toString("utf8");
    yield { type: "error", text: errText.trim() || `${argv[0]} exited with code ${exitCode}` };
  }
}
