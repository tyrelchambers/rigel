import { SiGithub } from "react-icons/si";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const badgeClass =
  "inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/50 text-muted-foreground transition-colors hover:border-border hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 outline-none";

/** A rounded GitHub chip naming the repo a chat PR touches; links to the PR when `href` is set. */
export function RepoBadge({ slug, href }: { slug: string; href?: string }) {
  const trigger = href ? (
    <a href={href} target="_blank" rel="noreferrer" aria-label={slug} className={badgeClass}>
      <SiGithub aria-hidden className="size-3" />
    </a>
  ) : (
    <span aria-label={slug} className={badgeClass}>
      <SiGithub aria-hidden className="size-3" />
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
