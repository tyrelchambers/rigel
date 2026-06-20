import { useMutation, useQuery } from "@tanstack/react-query";
import type { HelmChartSource } from "@rigel/k8s/src/helm";

export interface RunResult { code: number; stdout: string; stderr: string }
export interface ArtifactHubChart { name: string; version: string; description: string; repoName: string; source: HelmChartSource }

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

export function useArtifactHubSearch(query: string) {
  return useQuery<ArtifactHubChart[]>({
    queryKey: ["artifact-hub-search", query],
    queryFn: async () => {
      const res = await fetch(`/api/helm/search?q=${encodeURIComponent(query)}`);
      if (!res.ok) throw new Error(`search ${res.status}`);
      return res.json();
    },
    enabled: query.trim().length > 0,
    staleTime: 60_000,
  });
}

export function useHelmShowValues(ref: string | null, version?: string | null) {
  return useQuery<RunResult>({
    queryKey: ["helm-values", ref, version],
    queryFn: async () => {
      const q = new URLSearchParams({ ref: ref! });
      if (version) q.set("version", version);
      const res = await fetch(`/api/helm/show-values?${q.toString()}`);
      if (!res.ok) throw new Error(`show-values ${res.status}`);
      return res.json();
    },
    enabled: !!ref,
    staleTime: 60_000,
  });
}
