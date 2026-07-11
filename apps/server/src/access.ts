export type AccessMode = "cluster-wide" | "scoped";
export type Access = { mode: AccessMode; namespaces: string[] };

type RunKubectl = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export async function discoverAccess(opts: {
  context: string | null;
  seedNamespaces: string[];
  run: RunKubectl;
  maxNamespaces?: number;
}): Promise<Access> {
  const ctx = opts.context ? ["--context", opts.context] : [];
  const canListNs = await opts.run([...ctx, "auth", "can-i", "list", "namespaces"]);
  if (canListNs.code === 0 && canListNs.stdout.trim() === "yes") {
    return { mode: "cluster-wide", namespaces: [] };
  }
  const cap = opts.maxNamespaces ?? 10;
  return { mode: "scoped", namespaces: opts.seedNamespaces.slice(0, cap) };
}
