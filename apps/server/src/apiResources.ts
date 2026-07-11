// Parses `kubectl api-resources --no-headers` into distinct resource names +
// API groups, for the RBAC role editor's rule autocompletion.
import { kubectl } from "@rigel/k8s/src/run";

export interface ApiResourcesResult { resources: string[]; groups: string[] }

export function parseApiResources(stdout: string): ApiResourcesResult {
  const resources = new Set<string>();
  const groups = new Set<string>();

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
  }

  return {
    resources: [...resources].sort(),
    groups: [...groups].sort(),
  };
}

export async function getApiResources(context: string | null): Promise<ApiResourcesResult> {
  const res = await kubectl(context, ["api-resources", "--no-headers"]);
  if (res.code !== 0) return { resources: [], groups: [] };
  return parseApiResources(res.stdout);
}
