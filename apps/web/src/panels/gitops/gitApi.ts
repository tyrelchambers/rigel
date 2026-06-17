// GitOps HTTP client — /api/git/* (sources CRUD + sync). Sources never carry
// the PAT back to the browser; the token is write-only (sent on save, stored in
// a cluster Secret server-side).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface GitSource {
  name: string;
  repoURL: string;
  branch: string;
  path: string;
  lastSyncedSha?: string;
  lastSyncedAt?: string;
  lastStatus?: "ok" | "error";
  lastMessage?: string;
}

export interface SaveSourceInput {
  name: string;
  repoURL: string;
  branch?: string;
  path?: string;
  token?: string;
}

export interface SyncResult {
  code: number;
  stdout: string;
  stderr: string;
  sha?: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export function useGitSources() {
  return useQuery({
    queryKey: ["git-sources"],
    queryFn: () => req<{ sources: GitSource[] }>("/api/git/sources").then((r) => r.sources),
  });
}

export function useSaveSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveSourceInput) => req<{ sources: GitSource[] }>("/api/git/sources", json(input)),
    onSuccess: (r) => qc.setQueryData(["git-sources"], r.sources),
  });
}

export function useDeleteSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      req<{ sources: GitSource[] }>(`/api/git/sources?name=${encodeURIComponent(name)}`, { method: "DELETE" }),
    onSuccess: (r) => qc.setQueryData(["git-sources"], r.sources),
  });
}

/** Sync a source: dryRun → kubectl diff preview; otherwise clone + apply. */
export function syncSource(name: string, dryRun: boolean): Promise<SyncResult> {
  return req<SyncResult>("/api/git/sync", json({ name, dryRun }));
}
