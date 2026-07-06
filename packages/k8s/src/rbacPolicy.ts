export interface RbacPolicy {
  /** Sorted, deduped list of grant cells `${apiGroup}|${resource}|${verb}` (core apiGroup = ""). */
  cells: string[];
}

export const VERBS = ["get", "list", "watch", "create", "update", "patch", "delete"] as const;
export type Verb = (typeof VERBS)[number];

/** The (apiGroup, resource) rows editable in the matrix. Secrets included but flagged.
 *  roles/rolebindings/clusterroles are DELIBERATELY absent — the assistant can never be
 *  granted the ability to escalate itself. Read-only subresources (pods/log) aren't rows;
 *  reads are the get/list/watch verbs on the parent. `pods/eviction` (drain) is a row that
 *  only meaningfully takes `create`. `deployments/scale`/`statefulsets/scale` are write-only
 *  rows (their reads ship as part of the non-editable baseline). */
export const MATRIX_RESOURCES: { apiGroup: string; resource: string; secret?: boolean; onlyVerbs?: Verb[] }[] = [
  { apiGroup: "", resource: "pods" },
  { apiGroup: "", resource: "pods/eviction", onlyVerbs: ["create"] },
  { apiGroup: "", resource: "services" },
  { apiGroup: "", resource: "configmaps" },
  { apiGroup: "", resource: "persistentvolumeclaims" },
  { apiGroup: "", resource: "secrets", secret: true },
  { apiGroup: "", resource: "nodes", onlyVerbs: ["get", "list", "watch", "patch"] },
  { apiGroup: "apps", resource: "deployments" },
  { apiGroup: "apps", resource: "statefulsets" },
  { apiGroup: "apps", resource: "daemonsets" },
  { apiGroup: "apps", resource: "replicasets" },
  { apiGroup: "apps", resource: "deployments/scale", onlyVerbs: ["create", "update", "patch"] },
  { apiGroup: "apps", resource: "statefulsets/scale", onlyVerbs: ["create", "update", "patch"] },
  { apiGroup: "batch", resource: "jobs" },
  { apiGroup: "batch", resource: "cronjobs" },
  { apiGroup: "networking.k8s.io", resource: "ingresses" },
];

const REPRESENTABLE = new Set(
  MATRIX_RESOURCES.flatMap((r) =>
    (r.onlyVerbs ?? VERBS).map((v) => `${r.apiGroup}|${r.resource}|${v}`),
  ),
);

/** Encode a grant cell. */
export function cell(apiGroup: string, resource: string, verb: string): string {
  return `${apiGroup}|${resource}|${verb}`;
}

export function hasCell(policy: RbacPolicy, c: string): boolean {
  return policy.cells.includes(c);
}

/** Add or remove a cell; result stays sorted + deduped. Ignores non-representable cells. */
export function toggleCell(policy: RbacPolicy, c: string, on: boolean): RbacPolicy {
  if (on && !REPRESENTABLE.has(c)) return policy;
  const set = new Set(policy.cells);
  if (on) set.add(c);
  else set.delete(c);
  return { cells: [...set].sort() };
}

export function serializePolicy(policy: RbacPolicy): string {
  return JSON.stringify({ cells: [...new Set(policy.cells)].filter((c) => REPRESENTABLE.has(c)).sort() });
}

export function parsePolicy(json: string | undefined): RbacPolicy {
  if (!json) return { cells: [] };
  try {
    const raw = JSON.parse(json) as { cells?: unknown };
    const cells = Array.isArray(raw.cells) ? raw.cells.filter((c): c is string => typeof c === "string") : [];
    return { cells: [...new Set(cells)].filter((c) => REPRESENTABLE.has(c)).sort() };
  } catch {
    return { cells: [] };
  }
}
