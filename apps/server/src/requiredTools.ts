import { runProcess, type RunResult } from "@rigel/k8s/src/run";

export type RequiredTool = "kubectl" | "helm";

export interface MissingTool {
  bin: RequiredTool;
  installUrl: string;
}

export const REQUIRED_TOOLS: RequiredTool[] = ["kubectl", "helm"];

// Upstream install pages rather than a package-manager command: kubectl and helm
// are not in the default Linux distro repos, and `brew install …` is useless on
// a Mac without Homebrew. The page is right on every machine.
const INSTALL_URL: Record<RequiredTool, string> = {
  kubectl: "https://kubernetes.io/docs/tasks/tools/",
  helm: "https://helm.sh/docs/intro/install/",
};

// Cheapest invocation that proves the binary exists without touching a cluster.
const PROBE_ARGS: Record<RequiredTool, string[]> = {
  kubectl: ["version", "--client"],
  helm: ["version"],
};

const RECHECK_MS = 10_000;

type Runner = (bin: string, args: string[]) => Promise<RunResult>;

/**
 * A spawn failure means "binary missing" only when the OS said ENOENT. Any exit
 * code means the binary ran and something else (cluster, arguments) is wrong,
 * which the caller already reports its own way.
 */
export function isMissingBinaryError(result: { code: number; stderr: string }): boolean {
  return result.code === -1 && /\bENOENT\b/.test(result.stderr);
}

/**
 * Tracks which required binaries are missing from PATH.
 *
 * Healthy is the cheap case: one probe per binary at boot and nothing after
 * that. Every subsystem that shells out already surfaces ENOENT, and reports it
 * here, which flips the binary to missing immediately. Only while something is
 * missing does a timer re-probe, so the state clears on its own once the user
 * installs it.
 */
export class RequiredTools {
  private readonly missing = new Set<RequiredTool>();
  private readonly listeners = new Set<(state: MissingTool[]) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly run: Runner = runProcess,
    private readonly recheckMs: number = RECHECK_MS,
  ) {}

  state(): MissingTool[] {
    return REQUIRED_TOOLS.filter((bin) => this.missing.has(bin)).map((bin) => ({
      bin,
      installUrl: INSTALL_URL[bin],
    }));
  }

  subscribe(cb: (state: MissingTool[]) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Report a spawn failure from a call site. Ignored unless it is ENOENT. */
  noteSpawnFailure(bin: string, stderr: string): void {
    if (!isRequiredTool(bin)) return;
    if (!isMissingBinaryError({ code: -1, stderr })) return;
    this.markMissing(bin);
  }

  /** Probe every required binary. Used at boot and by the recheck timer. */
  async probeAll(): Promise<MissingTool[]> {
    const results = await Promise.all(
      REQUIRED_TOOLS.map(async (bin) => [bin, await this.run(bin, PROBE_ARGS[bin])] as const),
    );
    let changed = false;
    for (const [bin, result] of results) {
      const gone = isMissingBinaryError(result);
      if (gone && !this.missing.has(bin)) { this.missing.add(bin); changed = true; }
      if (!gone && this.missing.delete(bin)) changed = true;
    }
    this.syncTimer();
    if (changed) this.emit();
    return this.state();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private markMissing(bin: RequiredTool): void {
    if (this.missing.has(bin)) return;
    this.missing.add(bin);
    this.syncTimer();
    this.emit();
  }

  private syncTimer(): void {
    if (this.missing.size > 0 && !this.timer) {
      this.timer = setInterval(() => void this.probeAll(), this.recheckMs);
      this.timer.unref?.();
    } else if (this.missing.size === 0) {
      this.stop();
    }
  }

  private emit(): void {
    const state = this.state();
    for (const cb of this.listeners) cb(state);
  }
}

function isRequiredTool(bin: string): bin is RequiredTool {
  return (REQUIRED_TOOLS as string[]).includes(bin);
}

export const requiredTools = new RequiredTools();
