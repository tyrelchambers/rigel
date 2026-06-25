import { runProcess, type RunResult } from "@rigel/k8s/src/run";

export interface ClusterToolStatus {
  kind: boolean;
  k3d: boolean;
  /** docker daemon reachable (`docker info` exits 0). */
  dockerRunning: boolean;
}

type Runner = (bin: string, args: string[]) => Promise<RunResult>;

/** Probe for kind/k3d binaries and a running Docker. `run` is injectable for tests. */
export async function detectClusterTools(run: Runner = runProcess): Promise<ClusterToolStatus> {
  const [kind, k3d, docker] = await Promise.all([
    run("kind", ["version"]),
    run("k3d", ["version"]),
    run("docker", ["info"]),
  ]);
  return { kind: kind.code === 0, k3d: k3d.code === 0, dockerRunning: docker.code === 0 };
}
