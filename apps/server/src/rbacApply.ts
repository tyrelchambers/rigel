import { rbac, type RbacPolicy } from "@rigel/k8s";

/** Extract just the `kind: ClusterRole` document from the rendered manifest.
 *  The ClusterRole is cluster-scoped, so this is the only object a policy change
 *  touches — never the namespaced SA/Role/binding (which are install-time). */
export function clusterRoleOnly(policy: RbacPolicy, ns = "default"): string {
  const docs = rbac(ns, policy).split("\n---\n");
  const doc = docs.find((d) => /\bkind: ClusterRole\b/.test(d) && !/ClusterRoleBinding/.test(d));
  if (!doc) throw new Error("rbac() produced no ClusterRole document");
  return doc.trim();
}

export interface ApplyDeps {
  apply(context: string, yaml: string): Promise<{ code: number; stdout: string; stderr: string }>;
}
export interface ApplyResult { applied: string[]; failures: { context: string; error: string }[]; }

export async function applyPolicy(
  input: { policy: RbacPolicy; contexts: string[] },
  deps: ApplyDeps,
): Promise<ApplyResult> {
  const doc = clusterRoleOnly(input.policy);
  const applied: string[] = [];
  const failures: { context: string; error: string }[] = [];
  for (const context of input.contexts) {
    const r = await deps.apply(context, doc);
    if (r.code === 0) applied.push(context);
    else failures.push({ context, error: r.stderr || `exit ${r.code}` });
  }
  return { applied, failures };
}
