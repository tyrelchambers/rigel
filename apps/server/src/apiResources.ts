// Parses `kubectl api-resources -o wide --no-headers` into distinct resource
// names, API groups, and the verbs each resource supports, for the RBAC role
// editor's rule autocompletion.
import { kubectl } from "@rigel/k8s/src/run";

export interface ApiResourcesResult {
  resources: string[];
  groups: string[];
  verbsByResource: Record<string, string[]>;
}

export function parseApiResources(stdout: string): ApiResourcesResult {
  const resources = new Set<string>();
  const groups = new Set<string>();
  const verbs = new Map<string, Set<string>>();

  for (const line of stdout.split("\n")) {
    const cols = line.trim().split(/\s+/).filter((c) => c !== "");
    if (cols.length < 4) continue;
    const namespacedIdx = cols.findIndex((c) => c === "true" || c === "false");
    if (namespacedIdx < 2) continue;
    const apiVersion = cols[namespacedIdx - 1];
    const name = cols[0];
    const slash = apiVersion.lastIndexOf("/");
    const group = slash === -1 ? "core" : apiVersion.slice(0, slash);
    resources.add(name);
    groups.add(group);
    // -o wide adds KIND (namespacedIdx+1) then a comma-separated VERBS column.
    const verbCol = cols[namespacedIdx + 2];
    if (verbCol) {
      const set = verbs.get(name) ?? new Set<string>();
      for (const v of verbCol.split(",")) if (v) set.add(v);
      verbs.set(name, set);
    }
  }

  const verbsByResource: Record<string, string[]> = {};
  for (const [name, set] of verbs) verbsByResource[name] = [...set].sort();

  return {
    resources: [...resources].sort(),
    groups: [...groups].sort(),
    verbsByResource,
  };
}

export async function getApiResources(context: string | null): Promise<ApiResourcesResult> {
  const res = await kubectl(context, ["api-resources", "-o", "wide", "--no-headers"]);
  if (res.code !== 0) return { resources: [], groups: [], verbsByResource: {} };
  return parseApiResources(res.stdout);
}
