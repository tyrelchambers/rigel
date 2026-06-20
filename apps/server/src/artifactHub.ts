// Artifact Hub browse/search client. Artifact Hub is the CNCF registry that aggregates
// Helm charts; it does not host them, so each result resolves to either a repo
// (URL + chart) or an OCI ref that our installer consumes.
import type { HelmChartSource } from "@rigel/k8s/src/helm";

export interface ArtifactHubChart {
  name: string;
  displayName: string;
  version: string;
  description: string;
  repoName: string;
  logoURL: string | null;
  stars: number;
  official: boolean;
  verifiedPublisher: boolean;
  source: HelmChartSource;
}

interface RawPackage {
  name?: string;
  display_name?: string;
  version?: string;
  description?: string;
  logo_image_id?: string;
  stars?: number;
  official?: boolean;
  repository?: { name?: string; url?: string; official?: boolean; verified_publisher?: boolean };
}

export interface BrowseParams {
  query?: string;
  sort?: "stars" | "relevance";
  official?: boolean;
  verified?: boolean;
  offset?: number;
  limit?: number;
}

/** Build the Artifact Hub search URL for a browse/search request (Helm, kind=0). */
export function buildArtifactHubSearchURL(params: BrowseParams = {}): string {
  const query = (params.query ?? "").trim();
  const limit = Math.min(Math.max(Number.isFinite(params.limit) ? (params.limit as number) : 24, 1), 60);
  const offset = Number.isFinite(params.offset) ? Math.max(params.offset as number, 0) : 0;
  const sort = params.sort ?? (query ? "relevance" : "stars");
  const sp = new URLSearchParams();
  sp.set("kind", "0");
  // facets=false: we don't render facet aggregations, so skip computing them.
  sp.set("facets", "false");
  sp.set("limit", String(limit));
  sp.set("offset", String(offset));
  sp.set("sort", sort);
  if (query) sp.set("ts_query_web", query);
  if (params.official) sp.set("official", "true");
  if (params.verified) sp.set("verified_publisher", "true");
  return `https://artifacthub.io/api/v1/packages/search?${sp.toString()}`;
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
    out.push({
      name: p.name,
      displayName: p.display_name ?? p.name,
      version,
      description: p.description ?? "",
      repoName,
      logoURL: p.logo_image_id ? `https://artifacthub.io/image/${p.logo_image_id}` : null,
      stars: typeof p.stars === "number" ? p.stars : 0,
      official: Boolean(p.official || p.repository?.official),
      verifiedPublisher: Boolean(p.repository?.verified_publisher),
      source,
    });
  }
  return out;
}

export interface BrowseResult {
  items: ArtifactHubChart[];
  total: number;
}

/** Browse/search Artifact Hub for Helm charts; returns installable sources + total count. */
export async function browseArtifactHub(params: BrowseParams = {}): Promise<BrowseResult> {
  try {
    const res = await fetch(buildArtifactHubSearchURL(params), {
      headers: { Accept: "application/json", "User-Agent": "rigel" },
    });
    if (!res.ok) return { items: [], total: 0 };
    const total = Number(res.headers.get("Pagination-Total-Count") ?? "0") || 0;
    const items = parseArtifactHubResults(await res.json().catch(() => null));
    return { items, total };
  } catch {
    return { items: [], total: 0 };
  }
}
