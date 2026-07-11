export type AccessMode = "cluster-wide" | "scoped";
export type Access = { mode: AccessMode; namespaces: string[]; indeterminate?: boolean };

type RunKubectl = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export async function discoverAccess(opts: {
  context: string | null;
  seedNamespaces: string[];
  run: RunKubectl;
  maxNamespaces?: number;
}): Promise<Access> {
  const ctx = opts.context ? ["--context", opts.context] : [];
  const canListNs = await opts.run([...ctx, "auth", "can-i", "list", "namespaces"]);
  const out = canListNs.stdout.trim();
  if (out === "no") {
    const cap = opts.maxNamespaces ?? 10;
    return { mode: "scoped", namespaces: opts.seedNamespaces.slice(0, cap) };
  }
  if (out === "yes") return { mode: "cluster-wide", namespaces: [] };
  return { mode: "cluster-wide", namespaces: [], indeterminate: true };
}

export async function seedFromKubeconfig(
  context: string | null,
  run: RunKubectl,
): Promise<string[]> {
  const ctx = context ? ["--context", context] : [];
  const r = await run([
    ...ctx,
    "config",
    "view",
    "--minify",
    "-o",
    "jsonpath={..namespace}",
  ]);
  const ns = r.stdout.trim();
  return ns ? [ns] : [];
}
