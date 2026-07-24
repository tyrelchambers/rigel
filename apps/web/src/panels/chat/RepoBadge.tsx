import { SiGithub } from "react-icons/si";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const badgeClass =
  "inline-flex shrink-0 rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 outline-none";

/** The GitHub mark naming the repo a chat PR touches; links to the PR when `href` is set. */
export function RepoBadge({ slug, href }: { slug: string; href?: string }) {
  const trigger = href ? (
    <a href={href} target="_blank" rel="noreferrer" aria-label={slug} className={badgeClass}>
      <SiGithub aria-hidden className="size-4" />
    </a>
  ) : (
    <span aria-label={slug} className={badgeClass}>
      <SiGithub aria-hidden className="size-4" />
    </span>
  );
  return (
    <TooltipProvider delay={150}>
      <Tooltip>
        <TooltipTrigger render={trigger} />
        <TooltipContent>{slug}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
