import { spawn } from "node:child_process";

/**
 * Thin kubectl wrapper. In-cluster the agent authenticates with its mounted
 * ServiceAccount token (the RBAC cage), so no kubeconfig or --context is needed.
 * The agent's permissions are bounded by that ServiceAccount: destructive verbs
 * are simply absent, so the cluster itself refuses them regardless of any bug.
 */

export interface KubectlResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function kubectl(args: string[], stdin?: string): Promise<KubectlResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("kubectl", args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

/** `kubectl apply -f -` with the manifest piped in (JSON or YAML both work). */
export async function kubectlApply(manifest: string): Promise<KubectlResult> {
  return kubectl(["apply", "-f", "-"], manifest);
}

/** Fetch a resource as YAML for a pre-mutation backup. Returns null if absent. */
export async function getManifestYaml(
  kind: string,
  name: string,
  namespace: string | null,
): Promise<string | null> {
  const args = ["get", kind, name, "-o", "yaml"];
  if (namespace) args.push("-n", namespace);
  const res = await kubectl(args);
  return res.code === 0 ? res.stdout : null;
}
