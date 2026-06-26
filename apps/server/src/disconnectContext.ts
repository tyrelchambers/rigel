import { kubectl } from "@rigel/k8s/src/run";
import type { RunResult } from "@rigel/k8s/src/run";
import { backupKubeconfig } from "./kubeconfigBackup";

interface RawView {
  "current-context"?: string;
  contexts?: { name: string; context?: { cluster?: string; user?: string } }[];
}

/**
 * Build the `kubectl config delete-*` commands to fully remove a context: always
 * delete-context, plus delete-cluster / delete-user when no OTHER context still
 * references that cluster/user (so we don't orphan, but also don't delete a shared
 * cluster/user). Returns null when the target context isn't present.
 */
export function buildDisconnectCommands(view: RawView, target: string): string[][] | null {
  const ctxs = view.contexts ?? [];
  const t = ctxs.find((c) => c.name === target);
  if (!t) return null;
  const others = ctxs.filter((c) => c.name !== target);
  const cmds: string[][] = [["config", "delete-context", target]];
  const cluster = t.context?.cluster;
  const user = t.context?.user;
  if (cluster && !others.some((c) => c.context?.cluster === cluster)) cmds.push(["config", "delete-cluster", cluster]);
  if (user && !others.some((c) => c.context?.user === user)) cmds.push(["config", "delete-user", user]);
  // kubectl config delete-context leaves a dangling current-context when we remove
  // the current one; repoint it so bare kubectl keeps working (unset if none remain).
  if (view["current-context"] === target) {
    cmds.push(others.length ? ["config", "use-context", others[0]!.name] : ["config", "unset", "current-context"]);
  }
  return cmds;
}

export type Run = (args: string[]) => Promise<RunResult>;
export interface DisconnectDeps {
  kubeconfigPath: string;
  run?: Run;
  backup?: (p: string) => Promise<string | null>;
}
export interface DisconnectResult {
  ok: boolean;
  backupPath?: string | null;
  removed?: string;
  error?: string;
  stderr?: string;
}

/** Remove a kubeconfig context (disconnect a connected cluster). Backs up first.
 *  The actual remote cluster is never touched. `run` defaults to context-less kubectl. */
export async function disconnectContext(target: string, deps: DisconnectDeps): Promise<DisconnectResult> {
  const run = deps.run ?? ((args: string[]) => kubectl(null, args));
  const backup = deps.backup ?? ((p: string) => backupKubeconfig(p));
  const view = await run(["config", "view", "-o", "json"]);
  if (view.code !== 0) return { ok: false, error: "could not read kubeconfig", stderr: view.stderr };
  let parsed: RawView;
  try { parsed = JSON.parse(view.stdout) as RawView; }
  catch { return { ok: false, error: "invalid kubeconfig" }; }
  const cmds = buildDisconnectCommands(parsed, target);
  if (!cmds) return { ok: false, error: "context not found" };
  const backupPath = await backup(deps.kubeconfigPath);
  for (const c of cmds) {
    const r = await run(c);
    if (r.code !== 0) return { ok: false, backupPath, error: "disconnect failed", stderr: r.stderr };
  }
  return { ok: true, backupPath, removed: target };
}
