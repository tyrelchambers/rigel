// GitOps HTTP client — /api/git/* (sources CRUD + sync). Sources never carry
// the PAT back to the browser; the token is write-only (sent on save, stored in
// a cluster Secret server-side).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/** One independently-syncable manifest dir within a repo. */
export interface GitDeployment {
  name: string;
  path: string;
  lastSyncedSha?: string;
  lastSyncedAt?: string;
  lastStatus?: "ok" | "error";
  lastMessage?: string;
}

export interface GitSource {
  name: string;
  repoURL: string;
  branch: string;
  deployments: GitDeployment[];
}

export interface SaveSourceInput {
  name: string;
  repoURL: string;
  branch?: string;
  deployments?: { name: string; path: string }[];
}

export interface SaveDeploymentInput {
  repo: string;
  name: string;
  path: string;
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

/** Read one repo file's text (null path = disabled). Server holds the token. */
export function useRepoFile(repo: string, branch: string, path: string | null) {
  return useQuery({
    queryKey: ["repo-file", repo, branch, path],
    queryFn: () =>
      req<{ content: string }>(
        `/api/git/repo-file?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}&path=${encodeURIComponent(path!)}`,
      ),
    enabled: !!path,
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

/** Add or update one deployment under an existing repo. */
export function useSaveDeployment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveDeploymentInput) =>
      req<{ sources: GitSource[] }>("/api/git/sources/deployment", json(input)),
    onSuccess: (r) => qc.setQueryData(["git-sources"], r.sources),
  });
}

export function useDeleteDeployment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ repo, name }: { repo: string; name: string }) =>
      req<{ sources: GitSource[] }>(
        `/api/git/sources/deployment?repo=${encodeURIComponent(repo)}&name=${encodeURIComponent(name)}`,
        { method: "DELETE" },
      ),
    onSuccess: (r) => qc.setQueryData(["git-sources"], r.sources),
  });
}

/** Sync one deployment: dryRun → kubectl diff preview; otherwise clone + apply. */
export function syncDeployment(repo: string, deployment: string, dryRun: boolean): Promise<SyncResult> {
  return req<SyncResult>("/api/git/sync", json({ repo, deployment, dryRun }));
}

// ── Link to repo (bind a running Deployment to a GitOps source) ────────────────

/** A workload's resolved GitOps link (mirrors the server `RepoLink`). */
export interface RepoLink {
  /** The matched deployment slug == the rigel.dev/source-repo annotation value. */
  source: string;
  repoURL: string;
  /** "owner/name", or null for a non-GitHub URL. */
  repo: string | null;
  branch: string;
  path: string;
}

/** Per-Deployment link status from GET /api/git/link. */
export interface LinkStatus {
  linked: boolean;
  link: RepoLink | null;
}

export interface LinkRepoInput {
  namespace: string;
  deployment: string;
  repoURL: string;
  branch?: string;
  path?: string;
}

/** What was linked (mirrors the server `LinkRepoResult`). */
export interface LinkRepoResult {
  ok: boolean;
  source: string;
  repo: string;
  repoName: string;
  repoURL: string;
  branch: string;
  path: string;
}

/**
 * Per-project link status: whether a Deployment is bound to a GitOps source.
 * Enabled once a namespace + deployment are known. Used by the deployment list /
 * link control to show "Linked to owner/name" vs "Not linked".
 */
export function useRepoLink(namespace: string | null | undefined, deployment: string | null | undefined) {
  return useQuery({
    queryKey: ["repo-link", namespace, deployment],
    queryFn: () =>
      req<LinkStatus>(
        `/api/git/link?namespace=${encodeURIComponent(namespace!)}&deployment=${encodeURIComponent(deployment!)}`,
      ),
    enabled: !!namespace && !!deployment,
  });
}

/**
 * Link a running Deployment to a repo (the "Link to repo" flow): creates/extends
 * a rigel-git-sources entry AND stamps the live Deployment's provenance
 * annotation — no redeploy. Refreshes the sources list + that deployment's link.
 */
export function useLinkRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LinkRepoInput) => req<LinkRepoResult>("/api/git/link", json(input)),
    onSuccess: (_r, input) => {
      qc.invalidateQueries({ queryKey: ["git-sources"] });
      qc.invalidateQueries({ queryKey: ["repo-link", input.namespace, input.deployment] });
    },
  });
}
