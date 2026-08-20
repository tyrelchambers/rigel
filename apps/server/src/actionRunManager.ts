import { spawn, type ChildProcess } from "node:child_process";
import { buildKubectlArgs } from "@rigel/k8s/src/run";
import { spawnEnv } from "@rigel/k8s/src/toolPath";
import {
  buildAiActionEntry,
  summarizeActionDetail,
  type AiActionEntry,
} from "@rigel/k8s/src/aiActionLedger";
import { recordAiAction } from "./aiActionLedger";
import { buildCommand, PurgeActionError, type ActionBlock } from "./actions";

interface JsonSink { send(data: string): unknown }

/** Enough of each stream to summarize the run in the ledger; not a log store. */
const OUTPUT_CAPTURE_MAX = 2000;

export type AiActionRecorder = (context: string | null, entry: AiActionEntry) => void;

const defaultRecorder: AiActionRecorder = (context, entry) => {
  void recordAiAction(context, entry);
};

export interface ActionRunRequest {
  /** Caller-supplied opaque correlation id — echoed in every frame. */
  id: string;
  action: ActionBlock;
  /** Per-request context override; falls back to the connection's boot context. */
  context?: string | null;
}

interface InFlightRun {
  proc: ChildProcess;
  action: ActionBlock;
  /** The exact command spawned, for the ledger entry. */
  command: string;
  context: string | null;
  stdout: string;
  stderr: string;
}

/**
 * Per-connection action-run manager. Mirrors ClusterCreateManager but for
 * chat action-block execution: receives an `action.run` WS message, builds
 * the kubectl argv via the same `buildCommand` the REST route uses (preserving
 * all guards), spawns kubectl, and streams output line-by-line as
 * `action.progress` frames. Multiple concurrent runs are allowed (each
 * identified by the caller's `id`). Every completed run is appended to the
 * AI-action ledger (HELM-18), best-effort.
 *
 * Frame types emitted:
 *   { type: "action.progress", id, line }   — one stdout/stderr line
 *   { type: "action.done",     id, code }   — process exited
 *   { type: "action.error",    id, message} — invalid action or spawn failure
 */
export class ActionRunManager {
  private runs = new Map<string, InFlightRun>();

  constructor(
    private ws: JsonSink,
    private context: string | null,
    private spawnFn: typeof spawn = spawn,
    private record: AiActionRecorder = defaultRecorder,
  ) {}

  run(req: ActionRunRequest): void {
    const { id, action } = req;

    // Guard: a malformed action (missing object or non-string kind) must not
    // throw uncaught — surface it as an error frame.
    if (!action || typeof action.kind !== "string") {
      return this.error(id, "action.run requires an action with a string kind");
    }

    // Guard: a run already in flight with this id would be orphaned if we
    // overwrote it — reject the duplicate instead.
    if (this.runs.has(id)) {
      return this.error(id, `action run '${id}' is already in progress`);
    }

    // Guard: purge is a client-side flow — never reaches kubectl.
    if (action.kind === "purge") {
      return this.error(id, "purge is handled by the client purge flow, not a kubectl command");
    }

    // Guard: applyManifest and proposeRepoFix have dedicated REST endpoints.
    if (action.kind === "applyManifest") {
      return this.error(id, "applyManifest is applied via /api/apply, not the action stream");
    }
    if (action.kind === "proposeRepoFix") {
      return this.error(id, "proposeRepoFix opens a pull request via /api/git/propose-fix, not the action stream");
    }

    // Build the argv using the same builder the REST /api/action route uses.
    let argv: string[];
    try {
      argv = buildCommand(action);
    } catch (err) {
      if (err instanceof PurgeActionError) {
        return this.error(id, err.message);
      }
      return this.error(id, err instanceof Error ? err.message : String(err));
    }

    // Prepend --context exactly as the REST route does (via buildKubectlArgs).
    const context = req.context ?? this.context;
    const fullArgv = buildKubectlArgs(context, argv);

    let proc: ChildProcess;
    try {
      proc = this.spawnFn("kubectl", fullArgv, {
        stdio: ["ignore", "pipe", "pipe"],
        env: spawnEnv(),
      });
    } catch (err) {
      return this.error(id, err instanceof Error ? err.message : String(err));
    }
    const inFlight: InFlightRun = {
      proc,
      action,
      command: ["kubectl", ...fullArgv].join(" "),
      context,
      stdout: "",
      stderr: "",
    };
    this.runs.set(id, inFlight);

    this.pump(id, proc.stdout, "stdout");
    this.pump(id, proc.stderr, "stderr");
    proc.on("error", (err: Error) => {
      this.runs.delete(id);
      this.error(id, err.message);
    });
    proc.on("close", (code) => {
      if (this.runs.get(id) !== inFlight) return;
      this.runs.delete(id);
      this.ws.send(JSON.stringify({ type: "action.done", id, code: code ?? -1 }));
      this.ledger(inFlight, code ?? -1);
    });
  }

  /**
   * Append the finished run to the AI-action ledger. Always `chat`: the voice
   * worker never opens a /ws connection, it runs actions over REST /api/action.
   */
  private ledger(run: InFlightRun, code: number): void {
    const outcome = code === 0 ? "success" : "failure";
    this.record(
      run.context,
      buildAiActionEntry({
        action: run.action,
        source: "chat",
        command: run.command,
        outcome,
        detail: summarizeActionDetail(outcome, run.stdout, run.stderr),
      }),
    );
  }

  /** Forward a stream's lines as action.progress frames. */
  private pump(id: string, stream: NodeJS.ReadableStream | null, channel: "stdout" | "stderr"): void {
    if (!stream) return;
    let buf = "";
    const capture = (text: string) => {
      const run = this.runs.get(id);
      if (!run || run[channel].length >= OUTPUT_CAPTURE_MAX) return;
      run[channel] = (run[channel] + text).slice(0, OUTPUT_CAPTURE_MAX);
    };
    stream.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        capture(`${line}\n`);
        if (line.length > 0) this.ws.send(JSON.stringify({ type: "action.progress", id, line }));
      }
    });
    // Flush a final line with no trailing newline (e.g. `rollout pause` output).
    stream.on("end", () => {
      if (buf.length > 0) {
        capture(buf);
        this.ws.send(JSON.stringify({ type: "action.progress", id, line: buf }));
        buf = "";
      }
    });
  }

  private error(id: string, message: string): void {
    this.ws.send(JSON.stringify({ type: "action.error", id, message }));
  }

  /** Kill all in-flight runs (on ws close). Idempotent. */
  stop(): void {
    for (const run of this.runs.values()) {
      try { run.proc.kill(); } catch { /* already gone */ }
    }
    this.runs.clear();
  }
}
