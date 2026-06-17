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
}

export interface GithubAccount {
  connected: boolean;
  login: string | null;
}

export interface GithubRepo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  cloneURL: string;
}

export interface RepoEntry {
  name: string;
  path: string;
  type: "dir" | "file";
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

// ── GitHub account (single PAT) ───────────────────────────────────────────────

export function useGitHubAccount() {
  return useQuery({
    queryKey: ["github-account"],
    queryFn: () => req<GithubAccount>("/api/git/account"),
  });
}

export function useConnectGitHub() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => req<GithubAccount>("/api/git/account", json({ token })),
    onSuccess: (acct) => {
      qc.setQueryData(["github-account"], acct);
      qc.invalidateQueries({ queryKey: ["github-repos"] });
    },
  });
}

export function useDisconnectGitHub() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => req<GithubAccount>("/api/git/account", { method: "DELETE" }),
    onSuccess: (acct) => {
      qc.setQueryData(["github-account"], acct);
      qc.removeQueries({ queryKey: ["github-repos"] });
    },
  });
}

/** The connected account's repos — only fetched once connected. */
export function useGitHubRepos(enabled: boolean) {
  return useQuery({
    queryKey: ["github-repos"],
    queryFn: () => req<{ repos: GithubRepo[] }>("/api/git/repos").then((r) => r.repos),
    enabled,
  });
}

/** One directory level of a repo (the folder browser). Cached per (repo, branch, path). */
export function useRepoTree(repo: string, branch: string, path: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo-tree", repo, branch, path],
    queryFn: () =>
      req<{ entries: RepoEntry[] }>(
        `/api/git/repo-tree?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}`,
      ).then((r) => r.entries),
    enabled: enabled && !!repo && !!branch,
  });
}

// ── Sources ───────────────────────────────────────────────────────────────────

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
