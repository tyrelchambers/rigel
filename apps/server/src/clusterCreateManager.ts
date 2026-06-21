import { spawn, type ChildProcess } from "node:child_process";
import { validateClusterName, buildKindCreateArgs, buildK3dCreateArgs } from "./clusterCreate";
import { backupKubeconfig } from "./kubeconfigBackup";

interface JsonSink { send(data: string): unknown }
type BackupFn = (kubeconfigPath: string) => Promise<string | null>;

export interface CreateRequest {
  tool: "kind" | "k3d";
  name: string;
  version?: string;
}

/**
 * Per-connection cluster-create manager (analogue of LogStreamManager). Backs up
 * the kubeconfig, spawns the tool with KUBECONFIG pointed at the server's config
 * so the new context merges where /api/contexts reads it, streams progress, and
 * emits a terminal cluster.done / cluster.error. One in-flight create at a time.
 */
export class ClusterCreateManager {
  private proc: ChildProcess | null = null;

  constructor(
    private ws: JsonSink,
    private kubeconfigPath: string,
    private spawnFn: typeof spawn = spawn,
    private backupFn: BackupFn = (p) => backupKubeconfig(p),
  ) {}

  async create(req: CreateRequest): Promise<void> {
    const nameErr = validateClusterName(req.name);
    if (nameErr) return this.error(nameErr);
    if (req.tool !== "kind" && req.tool !== "k3d") return this.error("Unknown tool.");

    const backupPath = await this.backupFn(this.kubeconfigPath);

    const argv = req.tool === "kind"
      ? buildKindCreateArgs(req.name, req.version)
      : buildK3dCreateArgs(req.name, req.version);
    const context = `${req.tool}-${req.name}`;

    let proc: ChildProcess;
    try {
      proc = this.spawnFn(req.tool, argv, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, KUBECONFIG: this.kubeconfigPath },
      });
    } catch (err) {
      return this.error(err instanceof Error ? err.message : String(err));
    }
    this.proc = proc;

    this.pump(proc.stdout);
    this.pump(proc.stderr);
    proc.on("error", (err: Error) => this.error(err.message)); // ENOENT: tool missing
    proc.on("close", (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (code === 0) {
        this.ws.send(JSON.stringify({ type: "cluster.done", context, backupPath }));
      } else {
        this.error(`${req.tool} exited with code ${code ?? -1}`);
      }
    });
  }

  /** Forward a stream's lines as cluster.progress frames. */
  private pump(stream: NodeJS.ReadableStream | null): void {
    if (!stream) return;
    let buf = "";
    stream.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length > 0) this.ws.send(JSON.stringify({ type: "cluster.progress", line }));
      }
    });
  }

  private error(message: string): void {
    this.ws.send(JSON.stringify({ type: "cluster.error", message }));
  }

  /** Kill an in-flight create (on a new request or ws close). Idempotent. */
  stop(): void {
    try { this.proc?.kill(); } catch { /* already gone */ }
    this.proc = null;
  }
}
