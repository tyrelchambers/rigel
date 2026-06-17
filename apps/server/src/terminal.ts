// Interactive PTY terminal — a Rancher-style cluster shell. One pseudo-terminal
// per WebSocket connection, driven by Bun's native PTY support (Bun >= 1.3.5:
// the `terminal` option on Bun.spawn gives a real TTY with working I/O + resize
// — no node-pty, FFI, or extra Node process). The shell inherits the server's
// environment, so kubectl/helm resolve against the same kubeconfig/context the
// rest of the app uses. Gated by the same session auth as /ws.
import type { ServerWebSocket } from "bun";

const SHELL = process.env.HELMSMAN_SHELL ?? "/bin/bash";

/** Minimal sink — only `send(string)` is used, so tests can pass a stub. */
interface WsSink {
  send(data: string): void;
}

export class TerminalSession {
  private proc: Bun.Subprocess | null = null;
  private term: Bun.Terminal | null = null;
  // Streaming decoder so multi-byte UTF-8 sequences split across PTY chunks
  // (e.g. box-drawing glyphs in k9s) aren't corrupted at the boundary.
  private readonly decoder = new TextDecoder();

  constructor(private readonly ws: WsSink) {}

  /** Spawn the shell. No-op if one is already running (one PTY per connection). */
  start(cols: number, rows: number): void {
    if (this.proc) return;
    const ws = this.ws;
    const decoder = this.decoder;
    try {
      const proc = Bun.spawn([SHELL, "-i"], {
        cwd: process.env.HOME || "/root",
        env: { ...process.env, TERM: "xterm-256color" },
        terminal: {
          cols: clampDim(cols, 80),
          rows: clampDim(rows, 24),
          data(_term, chunk) {
            const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
            ws.send(JSON.stringify({ type: "term", event: "data", data: text }));
          },
        },
      });
      this.proc = proc;
      this.term = proc.terminal ?? null;
      void proc.exited.then((code) => {
        ws.send(JSON.stringify({ type: "term", event: "exit", code }));
        this.proc = null;
        this.term = null;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ws.send(JSON.stringify({ type: "term", event: "error", message: `failed to start shell: ${message}` }));
    }
  }

  /** Forward keystrokes / pasted text to the shell. */
  write(data: string): void {
    this.term?.write(data);
  }

  /** Propagate a browser terminal resize to the PTY (TIOCSWINSZ). */
  resize(cols: number, rows: number): void {
    this.term?.resize(clampDim(cols, 80), clampDim(rows, 24));
  }

  /** Kill the shell and tear down the PTY. Safe to call repeatedly. */
  stop(): void {
    try {
      this.proc?.kill();
    } catch {
      /* already gone */
    }
    try {
      this.term?.close();
    } catch {
      /* already closed */
    }
    this.proc = null;
    this.term = null;
  }
}

/** Guard against non-positive / absurd dimensions from a malformed client frame. */
function clampDim(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), 1000);
}
