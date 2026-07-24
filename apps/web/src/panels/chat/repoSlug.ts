import { findByDeployment, parseRepoSlug } from "@rigel/k8s";
import type { GitSource } from "@/panels/gitops/gitApi";
import type { SuggestedAction } from "@/lib/actionBlocks";

/** Resolve a proposeRepoFix `source` slug to its owning repo's `owner/repo`, or null. */
export function repoSlugFromSource(sources: GitSource[], source: string | undefined): string | null {
  if (!source) return null;
  const found = findByDeployment(sources, source);
  if (!found) return null;
  const slug = parseRepoSlug(found.repo.repoURL);
  return slug ? `${slug.owner}/${slug.repo}` : null;
}

const PR_URL = /https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/\d+/;

/** Pull `owner/repo` out of a GitHub pull-request URL in free text, or null. */
export function repoSlugFromText(text: string): string | null {
  const m = text.match(PR_URL);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The full GitHub pull-request URL found in free text, or null. */
export function prUrlFromText(text: string): string | null {
  return text.match(PR_URL)?.[0] ?? null;
}

/** The PR number from a GitHub pull-request URL, or null. */
export function prNumberFromUrl(url: string): number | null {
  const m = url.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

export interface RepoBadgeSpec {
  slug: string;
  href?: string;
}

/** Repo badges for a message: one per proposeRepoFix source (unlinked) + one for a PR URL in the text (linked). Deduped by slug. */
export function collectRepoBadges(
  actions: SuggestedAction[],
  text: string | undefined,
  sources: GitSource[] | undefined,
): RepoBadgeSpec[] {
  const out: RepoBadgeSpec[] = [];
  const seen = new Set<string>();
  const add = (slug: string | null, href?: string) => {
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    out.push(href ? { slug, href } : { slug });
  };
  for (const a of actions) {
    if (a.kind === "proposeRepoFix") add(repoSlugFromSource(sources ?? [], a.source));
  }
  add(repoSlugFromText(text ?? ""), prUrlFromText(text ?? "") ?? undefined);
  return out;
}
