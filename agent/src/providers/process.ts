import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** One mapped event from a CLI JSONL line. */
export interface CollectedEvent {
  type: "text" | "thinking" | "session" | "error" | "done";
  text?: string;
  sessionId?: string;
}

export interface CollectJsonlArgs {
  /** Full argv; argv[0] is the binary. */
  argv: string[];
  env: Record<string, string>;
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Map ONE parsed JSONL object to zero+ CollectedEvents. */
  mapEvent: (ev: any) => CollectedEvent[];
}

/** The collected outcome of one streamed CLI run. */
export interface CollectedRun {
  /** Concatenated text events (the final assistant message). */
  text: string;
  /** Last session id seen (for resume, when the CLI emits one). */
  sessionId?: string;
  isError: boolean;
  /** Failure detail when isError. */
  errorText?: string;
}

/**
 * Spawn a CLI, read newline-delimited JSON from stdout, map each line via
 * mapEvent, and COLLECT the final text + session id. Mirrors the chat's
 * streamAgentProcess (apps/server/src/agentProcess.ts) but returns the collected
 * result instead of yielding live events — the agent only needs the final message.
 * NEVER rejects for an expected failure (ENOENT, non-zero exit, mapped error): all
 * surface as { isError: true, errorText } so callers fail closed.
 */
export async function collectJsonlRun({
  argv,
  env,
  cwd,
  signal,
  timeoutMs,
  mapEvent,
}: CollectJsonlArgs): Promise<CollectedRun> {
  const proc = spawn(argv[0]!, argv.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    ...(cwd ? { cwd } : {}),
  });

  const stderrChunks: Buffer[] = [];
  proc.stderr!.on("data", (b: Buffer) => stderrChunks.push(b));

  let textOut = "";
  let sessionId: string | undefined;
  let mappedError: string | undefined;

  const timer = timeoutMs
    ? setTimeout(() => {
        try {
          proc.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      }, timeoutMs)
    : undefined;

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

  const exitPromise: Promise<number | null> = new Promise((resolve) => {
    proc.once("close", (code) => resolve(code));
    proc.once("error", (err: Error) => {
      stderrChunks.push(Buffer.from(err.message));
      resolve(-1);
    });
  });

  const rl = createInterface({ input: proc.stdout! });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    for (const e of mapEvent(ev)) {
      if (e.type === "text" && typeof e.text === "string") textOut += e.text;
      else if (e.type === "session" && typeof e.sessionId === "string") sessionId = e.sessionId;
      else if (e.type === "error" && typeof e.text === "string" && !mappedError) mappedError = e.text;
    }
  }

  const exitCode = await exitPromise;
  if (timer) clearTimeout(timer);
  if (signal) signal.removeEventListener("abort", onAbort);

  if (signal?.aborted) {
    return { text: textOut, sessionId, isError: true, errorText: "aborted" };
  }
  if (mappedError) {
    return { text: textOut, sessionId, isError: true, errorText: mappedError };
  }
  if (exitCode !== 0) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    return {
      text: textOut,
      sessionId,
      isError: true,
      errorText: formatProcessError(argv[0]!, stderr, exitCode),
    };
  }
  return { text: textOut, sessionId, isError: false };
}

/** Concise failure text — mirrors agentProcess.formatProcessError. */
function formatProcessError(binary: string, stderr: string, exitCode: number | null): string {
  const text = stderr.trim();
  if (/\bENOENT\b/.test(text)) {
    return `The "${binary}" CLI could not be found (ENOENT). Make sure it is installed in the image.`;
  }
  if (!text) return `${binary} exited with code ${exitCode}`;
  return text.length > 600 ? text.slice(0, 600) + "…" : text;
}
