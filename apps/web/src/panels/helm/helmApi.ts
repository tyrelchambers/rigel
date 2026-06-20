import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import type { HelmChartSource } from "@rigel/k8s/src/helm";

export interface RunResult { code: number; stdout: string; stderr: string }
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

export interface BrowsePage { items: ArtifactHubChart[]; total: number }
export interface BrowseParams { query?: string; sort?: "stars" | "relevance"; official?: boolean; verified?: boolean }

const BROWSE_LIMIT = 24;

/** Build the query string for GET /api/helm/browse. */
export function buildBrowseQuery(params: BrowseParams, offset: number, limit: number): string {
  const sp = new URLSearchParams();
  const q = params.query?.trim();
  if (q) sp.set("q", q);
  if (params.sort) sp.set("sort", params.sort);
  if (params.official) sp.set("official", "true");
  if (params.verified) sp.set("verified", "true");
  sp.set("offset", String(offset));
  sp.set("limit", String(limit));
  return sp.toString();
}

export function useArtifactHubBrowse(params: BrowseParams) {
  return useInfiniteQuery<BrowsePage>({
    queryKey: ["artifact-hub-browse", params],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const res = await fetch(`/api/helm/browse?${buildBrowseQuery(params, pageParam as number, BROWSE_LIMIT)}`);
      if (!res.ok) throw new Error(`browse ${res.status}`);
      return res.json() as Promise<BrowsePage>;
    },
    getNextPageParam: (lastPage, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
    staleTime: 60_000,
  });
}

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `${res.status}`);
  return res.json() as Promise<T>;
}

export interface HelmInstallParams { source: HelmChartSource; releaseName: string; namespace: string; values: string }
export function useHelmInstall() {
  return useMutation<RunResult, Error, HelmInstallParams>({ mutationFn: (p) => postJSON("/api/helm/install", p) });
}

export interface HelmRollbackParams { release: string; revision: number; namespace: string }
export function useHelmRollback() {
  return useMutation<RunResult, Error, HelmRollbackParams>({ mutationFn: (p) => postJSON("/api/helm/rollback", p) });
}

export interface HelmUninstallParams { release: string; namespace: string }
export function useHelmUninstall() {
  return useMutation<RunResult, Error, HelmUninstallParams>({ mutationFn: (p) => postJSON("/api/helm/uninstall", p) });
}

export function useHelmShowValues(ref: string | null, version?: string | null, repo?: string | null) {
  return useQuery<RunResult>({
    queryKey: ["helm-values", ref, version, repo],
    queryFn: async () => {
      const q = new URLSearchParams({ ref: ref! });
      if (version) q.set("version", version);
      if (repo) q.set("repo", repo);
      const res = await fetch(`/api/helm/show-values?${q.toString()}`);
      if (!res.ok) throw new Error(`show-values ${res.status}`);
      return res.json();
    },
    enabled: !!ref,
    staleTime: 60_000,
  });
}
