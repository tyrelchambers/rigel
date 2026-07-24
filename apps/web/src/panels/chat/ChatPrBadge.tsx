import { usePrStatus } from "@/panels/gitops/gitApi";
import { RepoBadge } from "./RepoBadge";
import { prNumberFromUrl } from "./repoSlug";

/** A repo badge for an opened-PR message: fetches live PR status and links to the PR. */
export function ChatPrBadge({ slug, href }: { slug: string; href: string }) {
  const { data } = usePrStatus(href);
  return <RepoBadge slug={slug} href={href} state={data?.state} prNumber={prNumberFromUrl(href) ?? undefined} />;
}
