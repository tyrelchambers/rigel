import type { ActionBlock } from "@/lib/api";

/** RBAC resource kinds accepted by the server's deleteResource action. */
export type RbacResourceKind = "role" | "clusterrole" | "rolebinding" | "clusterrolebinding";

/**
 * Build a guarded deleteResource ActionBlock for an RBAC object. Namespace is
 * included only when provided (cluster-scoped kinds pass it as undefined).
 */
export function buildDeleteAction(
  resourceKind: RbacResourceKind,
  name: string,
  namespace?: string,
): ActionBlock {
  const action: ActionBlock = {
    kind: "deleteResource",
    resourceKind,
    name,
    destructive: true,
    label: `Delete ${resourceKind} ${name}`,
  };
  if (namespace) action.namespace = namespace;
  return action;
}
