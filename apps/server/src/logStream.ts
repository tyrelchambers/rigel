// Log streaming: spawn one `kubectl logs -f` process per WebSocket connection
// and pipe its lines back over the socket. The Logs panel uses this instead of
// the watch manager (kubectl -f follows live output). See docs/parity/logs.md.
//
// Wire protocol (per WS connection):
//   in  { type: "logs.start", targets: [{ namespace, labelSelector?, pod?, container? }], tailLines? }
//   out { type: "logs", namespace, pod, container, line }   // one per output line
//   out { type: "logs.error", namespace, message }          // kubectl stderr / spawn failure
//   in  { type: "logs.stop" }                               // kill all this conn's procs
//   (ws close also kills all of this connection's procs — no zombies)
//
// A `target` is either a deployment (labelSelector) or a single pod. Pod/
// container in the outbound message are parsed from kubectl's `--prefix` line
// when present (multi-pod `-l` streams), else echoed from the target.

import { buildKubectlArgs } from "@rigel/k8s/src/run";
import { spawn, type ChildProcess } from "node:child_process";

/** Minimal sink for outbound JSON frames (a ServerWebSocket satisfies this). */
interface JsonSink {
  send(data: string): unknown;
}

export interface LogTarget {
  namespace: string;
  /** Deployment selector ("app=web,tier=fe"). Mutually exclusive with `pod`. */
  labelSelector?: string;
  /** Single pod name. Mutually exclusive with `labelSelector`. */
  pod?: string;
  container?: string;
  /** Fetch the previous (crashed) container instance; implies a one-shot (no -f). */
  previous?: boolean;
  /** kubectl --since window, e.g. "5m" or "1h". */
  since?: string;
}

interface SpawnedLog {
  proc: ChildProcess;
}

/**
 * Build the kubectl argv (without the `kubectl` binary / `--context`) for one
 * log target. Default mirrors the Swift tail command:
 *   logs -f --timestamps --prefix=true --all-containers=true -n <ns>
 *        (-l <selector> | <pod>) --max-log-requests=20 --tail=<n>
 * Extensions: `container` → `-c <c>` in place of `--all-containers`; `previous`
 * → `--previous` and DROP `-f` (a dead container can't be followed); `since` →
 * `--since=<v>`.
 */
export function buildLogsArgs(target: LogTarget, tailLines: number): string[] {
  const args = ["logs"];
  if (!target.previous) args.push("-f"); // --previous is a one-shot dump
  args.push("--timestamps", "--prefix=true");
  if (target.container) args.push("-c", target.container);
  else args.push("--all-containers=true");
  args.push("-n", target.namespace);
  if (target.labelSelector) {
    args.push("-l", target.labelSelector);
  } else if (target.pod) {
    args.push(target.pod);
  }
  if (target.previous) args.push("--previous");
  if (target.since) args.push(`--since=${target.since}`);
  args.push("--max-log-requests=20", `--tail=${tailLines}`);
  return args;
}

// kubectl --prefix line: `[pod/<pod>/<container>] <rest>` — used to attribute
// each line to its pod/container when streaming a multi-pod (-l) target.
const PREFIX_RE = /^\[pod\/([^/\]]+)\/([^\]]+)\]\s+/;

/**
 * Per-connection log-stream manager. Tracks every kubectl process spawned for a
 * WebSocket so `stop()` (on `logs.stop` or ws.close) can kill them all.
 */
export class LogStreamManager {
  private procs: SpawnedLog[] = [];

  constructor(
    private ws: JsonSink,
    private context: string | null,
    private spawnFn: typeof spawn = spawn,
  ) {}

  /** Start one kubectl-logs process per target. Replaces any current streams. */
  start(targets: LogTarget[], tailLines = 200): void {
    this.stop(); // a new start supersedes the previous selection
    for (const target of targets) {
      this.spawnOne(target, tailLines);
    }
  }

  private spawnOne(target: LogTarget, tailLines: number): void {
    const argv = buildKubectlArgs(this.context, buildLogsArgs(target, tailLines));
    let proc: ChildProcess;
    try {
      proc = this.spawnFn("kubectl", argv, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      this.sendError(target.namespace, err instanceof Error ? err.message : String(err));
      return;
    }
    const entry: SpawnedLog = { proc };
    this.procs.push(entry);

    // spawn delivers ENOENT (kubectl missing) asynchronously as an "error" event.
    proc.on("error", (err: Error) => this.sendError(target.namespace, err.message));
    this.pumpStdout(target, proc);
    this.pumpStderr(target, proc);
  }

  /** Read stdout line-by-line, parse the prefix, and forward each line. */
  private pumpStdout(target: LogTarget, proc: ChildProcess): void {
    let buf = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (raw.length > 0) this.forward(target, raw);
      }
    });
    proc.stdout?.on("end", () => {
      if (buf.length > 0) this.forward(target, buf);
    });
  }

  /** Surface kubectl stderr (auth/selector errors) as a logs.error message. */
  private pumpStderr(target: LogTarget, proc: ChildProcess): void {
    const chunks: Buffer[] = [];
    proc.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
    const emit = () => {
      const msg = Buffer.concat(chunks).toString("utf8").trim();
      if (msg) this.sendError(target.namespace, msg);
      chunks.length = 0;
    };
    proc.stderr?.on("end", emit);
  }

  /** Attribute one raw line to its pod/container and ship it to the client. */
  private forward(target: LogTarget, raw: string): void {
    let pod = target.pod ?? "";
    let container = target.container ?? "";
    const m = PREFIX_RE.exec(raw);
    if (m) {
      pod = m[1];
      container = m[2];
    }
    this.ws.send(
      JSON.stringify({
        type: "logs",
        namespace: target.namespace,
        pod,
        container,
        line: raw,
      }),
    );
  }

  private sendError(namespace: string, message: string): void {
    this.ws.send(JSON.stringify({ type: "logs.error", namespace, message }));
  }

  /** Kill every kubectl process spawned for this connection. Idempotent. */
  stop(): void {
    for (const { proc } of this.procs) {
      try {
        proc.kill();
      } catch {
        // already exited
      }
    }
    this.procs = [];
  }

  /** Number of live processes (for tests / introspection). */
  get activeCount(): number {
    return this.procs.length;
  }
}
