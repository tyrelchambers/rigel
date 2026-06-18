// Port-forward subprocess manager — server side of docs/parity/portforward.md.
//
// Manages the lifecycle of `kubectl port-forward` subprocesses spawned via
// node:child_process spawn (argv array — NO shell). Tracks active forwards in
// memory, allocates
// free local ports, monitors kubectl's stdout for the "Forwarding from
// 127.0.0.1:<port>" ready line, captures stderr for failures, and tears every
// child down on explicit stop and on server shutdown (no zombie kubectl).
//
// CRITICAL CAVEAT (surfaced in the UI too): the forward runs INSIDE the server
// container, so `127.0.0.1:<localPort>` is the SERVER's loopback. It is reachable
// from the host only when the server runs locally/non-containerized or when the
// port is published. The native macOS app forwarded directly onto your machine;
// this does not.

import { buildKubectlArgs } from "@helmsman/k8s/src/run";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { connect } from "node:net";

/** Server-side loopback bind address. kubectl defaults to this; constant by design. */
export const BIND_ADDRESS = "127.0.0.1";

/** Port allocation starts here and searches upward for a free local port. */
export const DEFAULT_START_PORT = 8000;

export type TargetKind = "svc" | "pod";
export type ForwardStatus = "starting" | "running" | "failed";

/** One tracked port-forward session. Shape is part of the REST contract. */
export interface ActiveForward {
  id: string;
  namespace: string;
  service?: string; // present when targetKind === "svc"
  pod?: string; // present when targetKind === "pod" (deferred on web)
  targetKind: TargetKind;
  localPort: number;
  remotePort: number;
  status: ForwardStatus;
  failureMessage?: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Pure functions (TDD)
// ---------------------------------------------------------------------------

/**
 * Build the kubectl argv for a port-forward (WITHOUT the leading `kubectl`).
 * `--context` is prepended first when supplied so the order is:
 *   ["--context", ctx, "port-forward", "<kind>/<name>", "<local>:<remote>", "-n", ns]
 */
export function buildPortForwardArgs(
  targetKind: string,
  targetName: string,
  namespace: string,
  localPort: number,
  remotePort: number,
  context?: string,
): string[] {
  const args: string[] = [];
  if (context) args.push("--context", context);
  args.push(
    "port-forward",
    `${targetKind}/${targetName}`,
    `${localPort}:${remotePort}`,
    "-n",
    namespace,
  );
  return args;
}

/**
 * Allocate a free local port. Ports held by non-failed forwards are skipped;
 * failed forwards no longer hold their port. Searches upward from `startPort`.
 * Throws when no port <= 65535 is available.
 */
export function findFreeLocalPort(
  activeForwards: ActiveForward[],
  startPort: number = DEFAULT_START_PORT,
): number {
  const usedPorts = new Set(
    activeForwards.filter((f) => f.status !== "failed").map((f) => f.localPort),
  );
  let port = startPort;
  while (port <= 65535 && usedPorts.has(port)) port++;
  if (port > 65535) throw new Error("No free local ports available");
  return port;
}

/**
 * True when `port` is bound by a non-failed forward in `activeForwards`.
 * A failed forward on the same port is NOT considered in use (it holds nothing).
 */
export function isLocalPortInUse(port: number, activeForwards: ActiveForward[]): boolean {
  return activeForwards.some((f) => f.status !== "failed" && f.localPort === port);
}

/** Validate a client-supplied local port: integer in [1, 65535]. */
export function isValidLocalPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

// ---------------------------------------------------------------------------
// Subprocess lifecycle manager
// ---------------------------------------------------------------------------

interface TrackedForward extends ActiveForward {
  proc: ChildProcess | null;
}

export interface StartResult {
  kind: "ok";
  forward: ActiveForward;
}
export interface ErrorResult {
  kind: "error";
  status: number;
  message: string;
}

function strip(f: TrackedForward): ActiveForward {
  const { proc: _proc, ...rest } = f;
  return rest;
}

/**
 * In-memory registry of `kubectl port-forward` subprocesses. One instance lives
 * for the lifetime of the server process; `stopAll()` runs from the shutdown hook.
 */
export class PortForwardManager {
  private forwards = new Map<string, TrackedForward>();
  private context: string | null;

  constructor(context: string | null) {
    this.context = context;
  }

  /** Active forwards (sans the live process handle), newest first. */
  list(): ActiveForward[] {
    return [...this.forwards.values()].map(strip).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Start a forward. Allocates a local port when none is given, rejects a
   * duplicate (409) or out-of-range (422) port, then spawns kubectl. The
   * returned forward is "starting"; it transitions to "running"/"failed"
   * asynchronously as kubectl reports, so the UI polls `list()` to observe it.
   */
  start(params: {
    namespace: string;
    service: string;
    remotePort: number;
    localPort?: number;
    context?: string;
    targetKind?: TargetKind;
  }): StartResult | ErrorResult {
    const namespace = (params.namespace ?? "").trim();
    const service = (params.service ?? "").trim();
    const targetKind = params.targetKind ?? "svc";

    if (namespace === "" || service === "") {
      return { kind: "error", status: 422, message: "namespace and service are required" };
    }
    if (!isValidLocalPort(params.remotePort)) {
      return { kind: "error", status: 422, message: "remotePort must be an integer 1–65535" };
    }

    const active = this.list();
    let localPort: number;
    if (params.localPort != null) {
      if (!isValidLocalPort(params.localPort)) {
        return { kind: "error", status: 422, message: "localPort must be an integer 1–65535" };
      }
      if (isLocalPortInUse(params.localPort, active)) {
        return {
          kind: "error",
          status: 409,
          message: `Local port ${params.localPort} is already in use by another forward`,
        };
      }
      localPort = params.localPort;
    } else {
      try {
        localPort = findFreeLocalPort(active);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { kind: "error", status: 500, message };
      }
    }

    const id = crypto.randomUUID();
    const args = buildKubectlArgs(
      params.context ?? this.context,
      buildPortForwardArgs(
        targetKind,
        service,
        namespace,
        localPort,
        params.remotePort,
        // context is folded in by buildKubectlArgs; keep buildPortForwardArgs
        // context-free here to avoid double --context.
        undefined,
      ),
    );

    let proc: ChildProcess;
    try {
      proc = spawn("kubectl", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // ENOENT etc. — kubectl not on PATH.
      return { kind: "error", status: 500, message: `kubectl not found: ${message}` };
    }

    const tracked: TrackedForward = {
      id,
      namespace,
      service: targetKind === "svc" ? service : undefined,
      pod: targetKind === "pod" ? service : undefined,
      targetKind,
      localPort,
      remotePort: params.remotePort,
      status: "starting",
      createdAt: Date.now(),
      proc,
    };
    this.forwards.set(id, tracked);
    this.monitor(tracked);

    return { kind: "ok", forward: strip(tracked) };
  }

  /** Stop a forward by id: SIGTERM the child and drop it from the registry. */
  async stop(id: string): Promise<boolean> {
    const f = this.forwards.get(id);
    if (!f) return false;
    this.forwards.delete(id);
    await this.terminate(f);
    return true;
  }

  /** Kill every forward (server shutdown hook). No zombie kubectl left behind. */
  async stopAll(): Promise<void> {
    const all = [...this.forwards.values()];
    this.forwards.clear();
    await Promise.all(all.map((f) => this.terminate(f)));
  }

  private async terminate(f: TrackedForward): Promise<void> {
    if (!f.proc) return;
    const proc = f.proc;
    try {
      proc.kill(); // SIGTERM
      if (proc.exitCode === null && proc.signalCode === null) await once(proc, "close");
    } catch {
      /* already gone */
    } finally {
      f.proc = null;
    }
  }

  /**
   * Watch a freshly-spawned forward: flip to "running" on the
   * "Forwarding from 127.0.0.1:<port>" stdout line, or to "failed" with the
   * captured stderr when the process exits before reporting ready.
   */
  private monitor(f: TrackedForward): void {
    const proc = f.proc;
    if (!proc) return;
    const stderrChunks: string[] = [];

    // Drain stderr in the background for the failure message.
    proc.stderr?.on("data", (buf: Buffer) => stderrChunks.push(buf.toString("utf8")));

    // Watch stdout for the ready line.
    proc.stdout?.on("data", (buf: Buffer) => {
      if (buf.toString("utf8").includes("Forwarding from")) {
        const live = this.forwards.get(f.id);
        if (live && live.status === "starting") live.status = "running";
      }
    });

    const fail = () => {
      const live = this.forwards.get(f.id);
      if (live && live.status === "starting") {
        live.status = "failed";
        live.failureMessage =
          stderrChunks.join("").trim().split("\n")[0] || "port-forward exited";
      }
    };

    // spawn delivers ENOENT (kubectl missing) asynchronously as an "error" event
    // (no "close" follows when the child never started), so flip to "failed" here.
    proc.on("error", (err: Error) => {
      stderrChunks.push(err.message);
      fail();
    });

    // If the process exits while still "starting", it failed to bind.
    proc.on("close", fail);
  }
}

// ---------------------------------------------------------------------------
// Liveness probe (optional; not used by the in-memory manager but exported for
// completeness per the spec's isLocalPortInUse OS-level intent).
// ---------------------------------------------------------------------------

/** True if a TCP listener is accepting connections on 127.0.0.1:<port>. */
export function isPortListening(port: number, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: BIND_ADDRESS, port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}
