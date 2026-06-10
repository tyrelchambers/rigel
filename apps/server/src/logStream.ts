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

import { buildKubectlArgs } from "@helmsman/k8s/src/run";

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
}

interface SpawnedLog {
  proc: ReturnType<typeof Bun.spawn>;
}

/**
 * Build the kubectl argv (without the `kubectl` binary, without `--context`)
 * for one log target. Mirrors the Swift tail command exactly:
 *   logs -f --timestamps --prefix=true --all-containers=true
 *        -n <ns> (-l <selector> | <pod>)
 *        --max-log-requests=20 --tail=<n>
 */
export function buildLogsArgs(target: LogTarget, tailLines: number): string[] {
  const args = [
    "logs",
    "-f",
    "--timestamps",
    "--prefix=true",
    "--all-containers=true",
    "-n",
    target.namespace,
  ];
  if (target.labelSelector) {
    args.push("-l", target.labelSelector);
  } else if (target.pod) {
    args.push(target.pod);
  }
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
    private spawnFn: typeof Bun.spawn = Bun.spawn,
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
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = this.spawnFn(["kubectl", ...argv], { stdout: "pipe", stderr: "pipe" });
    } catch (err) {
      this.sendError(target.namespace, err instanceof Error ? err.message : String(err));
      return;
    }
    const entry: SpawnedLog = { proc };
    this.procs.push(entry);

    void this.pumpStdout(target, proc.stdout as ReadableStream<Uint8Array>);
    void this.pumpStderr(target, proc.stderr as ReadableStream<Uint8Array>);
  }

  /** Read stdout line-by-line, parse the prefix, and forward each line. */
  private async pumpStdout(target: LogTarget, stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const raw = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (raw.length > 0) this.forward(target, raw);
        }
      }
      if (buf.length > 0) this.forward(target, buf);
    } catch {
      // Stream torn down (process killed on stop/close) — nothing to forward.
    }
  }

  /** Surface kubectl stderr (auth/selector errors) as a logs.error message. */
  private async pumpStderr(target: LogTarget, stream: ReadableStream<Uint8Array>): Promise<void> {
    try {
      const text = await new Response(stream).text();
      const msg = text.trim();
      if (msg) this.sendError(target.namespace, msg);
    } catch {
      // ignore — process likely killed
    }
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
