// Interactive PTY terminal — a Rancher-style cluster shell. One pseudo-terminal
// per WebSocket connection, driven by node-pty (a real TTY with working I/O +
// resize that runs under Node/Electron). The shell inherits the server's
// environment, so kubectl/helm resolve against the same kubeconfig/context the
// rest of the app uses. Gated by the same session auth as /ws.
import * as pty from "node-pty";

const SHELL = process.env.HELMSMAN_SHELL ?? "/bin/bash";

/** Minimal sink — only `send(string)` is used, so tests can pass a stub. */
interface WsSink {
  send(data: string): void;
}

export class TerminalSession {
  private proc: pty.IPty | null = null;

  constructor(private readonly ws: WsSink) {}

  /** Spawn the shell. No-op if one is already running (one PTY per connection). */
  start(cols: number, rows: number): void {
    if (this.proc) return;
    const ws = this.ws;
    try {
      const proc = pty.spawn(SHELL, ["-i"], {
        name: "xterm-256color",
        cols: clampDim(cols, 80),
        rows: clampDim(rows, 24),
        cwd: process.env.HOME || "/root",
        env: { ...process.env, TERM: "xterm-256color" },
      });
      this.proc = proc;
      // node-pty delivers an already-decoded string, so no TextDecoder is needed.
      proc.onData((data: string) => {
        ws.send(JSON.stringify({ type: "term", event: "data", data }));
      });
      proc.onExit(({ exitCode }) => {
        ws.send(JSON.stringify({ type: "term", event: "exit", code: exitCode }));
        this.proc = null;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ws.send(JSON.stringify({ type: "term", event: "error", message: `failed to start shell: ${message}` }));
    }
  }

  /** Forward keystrokes / pasted text to the shell. */
  write(data: string): void {
    this.proc?.write(data);
  }

  /** Propagate a browser terminal resize to the PTY (TIOCSWINSZ). */
  resize(cols: number, rows: number): void {
    this.proc?.resize(clampDim(cols, 80), clampDim(rows, 24));
  }

  /** Kill the shell and tear down the PTY. Safe to call repeatedly. */
  stop(): void {
    try {
      this.proc?.kill();
    } catch {
      /* already gone */
    }
    this.proc = null;
  }
}

/** Guard against non-positive / absurd dimensions from a malformed client frame. */
function clampDim(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), 1000);
}
