import { join } from "node:path";

/** Resolve the kubeconfig path: explicit KUBECONFIG wins, else ~/.kube/config. */
export function resolveKubeconfigPath(env: Record<string, string | undefined>, home: string): string {
  const fromEnv = env.KUBECONFIG?.trim();
  if (fromEnv) return fromEnv;
  return join(home, ".kube", "config");
}
