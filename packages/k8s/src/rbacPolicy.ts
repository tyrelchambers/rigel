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
  if (on && (!REPRESENTABLE.has(c) || isBaselineReadCell(c))) return policy;
  const set = new Set(policy.cells);
  if (on) set.add(c);
  else set.delete(c);
  return { cells: [...set].sort() };
}

export function serializePolicy(policy: RbacPolicy): string {
  return JSON.stringify({ cells: [...new Set(policy.cells)].filter((c) => REPRESENTABLE.has(c) && !isBaselineReadCell(c)).sort() });
}

export function parsePolicy(json: string | undefined): RbacPolicy {
  if (!json) return { cells: [] };
  try {
    const raw = JSON.parse(json) as { cells?: unknown };
    const cells = Array.isArray(raw.cells) ? raw.cells.filter((c): c is string => typeof c === "string") : [];
    return { cells: [...new Set(cells)].filter((c) => REPRESENTABLE.has(c) && !isBaselineReadCell(c)).sort() };
  } catch {
    return { cells: [] };
  }
}

export type Risk = "safe" | "destructive" | "secret";
export interface Capability {
  id: string;
  label: string;
  description: string;
  risk: Risk;
  /** The exact cells this capability grants. */
  cells: string[];
  /** Baseline capabilities are always-on and non-editable (rendered informational). */
  baseline?: boolean;
}

const READ_VERBS: Verb[] = ["get", "list", "watch"];
const WRITE_VERBS: Verb[] = ["create", "update", "patch"];
/** `deployments/scale`/`statefulsets/scale` reads ship as part of the non-editable
 *  baseline (see BASELINE_RULES in assistant.ts), so the "read" capability
 *  excludes them to avoid granting/duplicating a read the policy doesn't control. */
const SCALE_SUBRESOURCES = ["deployments/scale", "statefulsets/scale"];
const readResources = MATRIX_RESOURCES.filter(
  (r) => !r.secret && r.resource !== "pods/eviction" && !SCALE_SUBRESOURCES.includes(r.resource),
);
const writeResources = MATRIX_RESOURCES.filter(
  (r) => !r.secret && !["pods/eviction", "nodes"].includes(r.resource),
);

export const CAPABILITIES: Capability[] = [
  {
    id: "read", label: "Read everything", description: "Inspect any resource except Secrets", risk: "safe",
    baseline: true,
    cells: readResources.flatMap((r) => READ_VERBS.map((v) => cell(r.apiGroup, r.resource, v))),
  },
  {
    id: "reversible", label: "Restart · scale · rollback · edit",
    description: "Reversible changes to workloads, pods, config and ingresses", risk: "safe",
    cells: writeResources.flatMap((r) => WRITE_VERBS.map((v) => cell(r.apiGroup, r.resource, v))),
  },
  {
    id: "deletePods", label: "Delete pods",
    description: "Clear a crashlooping pod — it respawns under its controller", risk: "safe",
    cells: [cell("", "pods", "delete")],
  },
  {
    id: "cordon", label: "Cordon / uncordon nodes", description: "Mark a node un/schedulable", risk: "safe",
    cells: [cell("", "nodes", "patch")],
  },
  {
    id: "deleteWorkloads", label: "Delete workloads",
    description: "Deployments, statefulsets, services, config, PVCs", risk: "destructive",
    cells: [
      ...["deployments", "statefulsets", "daemonsets", "replicasets"].map((r) => cell("apps", r, "delete")),
      ...["services", "configmaps", "persistentvolumeclaims"].map((r) => cell("", r, "delete")),
    ],
  },
  {
    id: "drain", label: "Drain nodes", description: "Evict pods off a node", risk: "destructive",
    cells: [cell("", "pods/eviction", "create")],
  },
  {
    id: "secrets", label: "Manage secrets",
    description: "Read and write Secret values — the model can see them", risk: "secret",
    cells: [...READ_VERBS, ...WRITE_VERBS, "delete" as Verb].map((v) => cell("", "secrets", v)),
  },
];

const CAP_BY_ID = new Map(CAPABILITIES.map((c) => [c.id, c]));

export const DEFAULT_POLICY: RbacPolicy = {
  cells: [...new Set(["reversible", "deletePods", "cordon"].flatMap((id) => CAP_BY_ID.get(id)!.cells))].sort(),
};

/** The get/list/watch cells that ship as part of the non-editable baseline
 *  (BASELINE_RULES in assistant.ts). Equal to what the old "read" capability
 *  granted; the capability stays for display but is baseline-managed now. */
const BASELINE_READ_CELLS = new Set(CAP_BY_ID.get("read")!.cells);

export function isBaselineReadCell(c: string): boolean {
  return BASELINE_READ_CELLS.has(c);
}

/** Remove any baseline read cell so the rendered ClusterRole never duplicates a
 *  read the baseline already grants — regardless of what a stored policy holds. */
export function subtractBaseline(policy: RbacPolicy): RbacPolicy {
  return { cells: policy.cells.filter((c) => !BASELINE_READ_CELLS.has(c)) };
}

export function capabilityState(policy: RbacPolicy, capId: string): "on" | "off" | "partial" {
  const cap = CAP_BY_ID.get(capId);
  if (!cap) return "off";
  const present = cap.cells.filter((c) => hasCell(policy, c)).length;
  if (present === 0) return "off";
  if (present === cap.cells.length) return "on";
  return "partial";
}

export function setCapability(policy: RbacPolicy, capId: string, on: boolean): RbacPolicy {
  const cap = CAP_BY_ID.get(capId);
  if (!cap) return policy;
  return cap.cells.reduce((p, c) => toggleCell(p, c, on), policy);
}

export interface PolicyRule { apiGroups: string[]; resources: string[]; verbs: string[]; }

/** Group cells into ClusterRole rules: for each (apiGroup, resource) collect its verbs,
 *  then merge resources in the same apiGroup that share an identical verb set into one rule. */
export function policyToClusterRoleRules(policy: RbacPolicy): PolicyRule[] {
  const byGroupResource = new Map<string, Set<string>>(); // `${apiGroup}\n${resource}` -> verbs
  for (const c of policy.cells) {
    const [apiGroup, resource, verb] = c.split("|");
    const k = `${apiGroup}\n${resource}`;
    (byGroupResource.get(k) ?? byGroupResource.set(k, new Set()).get(k)!).add(verb);
  }
  const byGroupVerbset = new Map<string, { apiGroup: string; resources: string[]; verbs: string[] }>();
  for (const [k, verbSet] of byGroupResource) {
    const [apiGroup, resource] = k.split("\n");
    const verbs = [...verbSet].sort();
    const key = `${apiGroup}\n${verbs.join(",")}`;
    const entry = byGroupVerbset.get(key) ?? byGroupVerbset.set(key, { apiGroup, resources: [], verbs }).get(key)!;
    entry.resources.push(resource);
  }
  return [...byGroupVerbset.values()]
    .map((e) => ({ apiGroups: [e.apiGroup], resources: e.resources.sort(), verbs: e.verbs }))
    .sort((a, b) => (a.apiGroups[0] + a.resources[0]).localeCompare(b.apiGroups[0] + b.resources[0]));
}

export interface PolicyDiff { added: string[]; removed: string[]; }
export function diffPolicies(current: RbacPolicy, next: RbacPolicy): PolicyDiff {
  const cur = new Set(current.cells);
  const nxt = new Set(next.cells);
  return {
    added: next.cells.filter((c) => !cur.has(c)).sort(),
    removed: current.cells.filter((c) => !nxt.has(c)).sort(),
  };
}
