import { runProcess, type RunResult } from "@rigel/k8s/src/run";

export type ClusterOS = "mac" | "windows" | "linux";

/** The package manager behind the suggested kind install command, and whether
 * it's actually on PATH. `null` on Linux, whose recommended path is the binary
 * download (no package manager to have). */
export interface ClusterInstaller {
  id: "brew" | "winget";
  present: boolean;
}

export interface ClusterToolStatus {
  kind: boolean;
  k3d: boolean;
  /** docker daemon reachable (`docker info` exits 0). */
  dockerRunning: boolean;
  /** OS Rigel is running on, so the UI shows install commands that work here. */
  os: ClusterOS;
  /** OS package manager for the install command (probed), or null on Linux. */
  installer: ClusterInstaller | null;
}

type Runner = (bin: string, args: string[]) => Promise<RunResult>;

function toOS(platform: NodeJS.Platform): ClusterOS {
  return platform === "darwin" ? "mac" : platform === "win32" ? "windows" : "linux";
}

// The package manager we hand the user for `<pm> install kind`, per OS. Linux
// installs from the release binary, so there's nothing to probe.
const INSTALLER_ID: Record<ClusterOS, ClusterInstaller["id"] | null> = {
  mac: "brew",
  windows: "winget",
  linux: null,
};

/** Probe for kind/k3d binaries, a running Docker, and the OS package manager.
 * `run`/`platform` are injectable for tests. */
export async function detectClusterTools(
  run: Runner = runProcess,
  platform: NodeJS.Platform = process.platform,
): Promise<ClusterToolStatus> {
  const os = toOS(platform);
  const installerId = INSTALLER_ID[os];
  const [kind, k3d, docker, installer] = await Promise.all([
    run("kind", ["version"]),
    run("k3d", ["version"]),
    run("docker", ["info"]),
    installerId ? run(installerId, ["--version"]) : Promise.resolve(null),
  ]);
  return {
    kind: kind.code === 0,
    k3d: k3d.code === 0,
    dockerRunning: docker.code === 0,
    os,
    installer: installerId ? { id: installerId, present: installer?.code === 0 } : null,
  };
}
