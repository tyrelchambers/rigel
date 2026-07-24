import { parseRepoSlug, type AssistantPullRequest } from "@rigel/k8s";
import { prNumberFromUrl } from "@/panels/chat/repoSlug";
import type { ChatPrRecord } from "@/panels/gitops/gitApi";

/** Who opened the PR: the desktop chat assistant, or the in-cluster agent. */
export type PrOrigin = "chat" | "agent";

/** One row of the Pending PRs card, normalized from either PR source. */
export interface PrRowModel {
  key: string;
  origin: PrOrigin;
  prUrl?: string;
  number?: number;
  repoSlug: string;
  title: string;
  /** Deployment slug — resolves the repo + deployment for a Sync. */
  source: string;
  createdAt: string;
  /** Status to show when there is no PR to poll (an agent fix that never opened one). */
  fallbackState?: "failed";
}

/** Merge chat-opened and agent-opened PRs into one newest-first list, deduped by PR url. */
export function mergePrRows(chat: ChatPrRecord[], agent: AssistantPullRequest[]): PrRowModel[] {
  const rows: PrRowModel[] = [
    ...chat.map((c) => ({
      key: c.id,
      origin: "chat" as const,
      prUrl: c.prUrl,
      number: c.number,
      repoSlug: c.repoSlug,
      title: c.title,
      source: c.source,
      createdAt: c.createdAt,
    })),
    ...agent.map((a) => {
      const slug = parseRepoSlug(a.repo);
      return {
        key: `${a.fingerprint}|${a.filePath}|${a.at}`,
        origin: "agent" as const,
        prUrl: a.prUrl,
        number: a.prUrl ? (prNumberFromUrl(a.prUrl) ?? undefined) : undefined,
        repoSlug: slug ? `${slug.owner}/${slug.repo}` : a.repo || a.app,
        title: a.title,
        source: a.app,
        createdAt: a.at,
        fallbackState: a.status === "failed" ? ("failed" as const) : undefined,
      };
    }),
  ].sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt));

  const seen = new Set<string>();
  return rows.filter((r) => {
    if (!r.prUrl) return true;
    if (seen.has(r.prUrl)) return false;
    seen.add(r.prUrl);
    return true;
  });
}
