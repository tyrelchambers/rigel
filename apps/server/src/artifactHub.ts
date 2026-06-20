// Artifact Hub search client. Artifact Hub is the CNCF registry that aggregates
// Helm charts; it does not host them, so each result resolves to either a repo
// (URL + chart) or an OCI ref that our installer consumes.
import type { HelmChartSource } from "@rigel/k8s/src/helm";

export interface ArtifactHubChart {
  name: string;
  version: string;
  description: string;
  repoName: string;
  source: HelmChartSource;
}

interface RawPackage {
  name?: string;
  version?: string;
  description?: string;
  repository?: { name?: string; url?: string };
}

/** Map an Artifact Hub search response into installable chart sources. */
export function parseArtifactHubResults(json: unknown): ArtifactHubChart[] {
  const pkgs = (json as { packages?: RawPackage[] } | null)?.packages;
  if (!Array.isArray(pkgs)) return [];
  const out: ArtifactHubChart[] = [];
  for (const p of pkgs) {
    if (!p.name || !p.repository?.url) continue;
    const version = p.version ?? "";
    const url = p.repository.url;
    const repoName = p.repository.name ?? "repo";
    const source: HelmChartSource = url.startsWith("oci://")
      ? { kind: "oci", ref: `${url.replace(/\/$/, "")}/${p.name}`, version: version || null }
      : { kind: "repo", repoName, repoURL: url, chart: p.name, version: version || null };
    out.push({ name: p.name, version, description: p.description ?? "", repoName, source });
  }
  return out;
}

/** Query the Artifact Hub search API for Helm charts (kind=0). */
export async function searchArtifactHub(query: string): Promise<ArtifactHubChart[]> {
  const url = `https://artifacthub.io/api/v1/packages/search?kind=0&limit=20&ts_query_web=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "rigel" } });
    if (!res.ok) return [];
    return parseArtifactHubResults(await res.json().catch(() => null));
  } catch {
    return [];
  }
}
