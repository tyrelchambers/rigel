import { SiGithub } from "react-icons/si";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { PrState } from "@/panels/gitops/gitApi";

const badgeClass =
  "inline-flex shrink-0 rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 outline-none";

const STATE_TINT: Record<PrState, string> = {
  open: "text-amber-500",
  merged: "text-purple-500",
  closed: "text-muted-foreground",
};

/** The GitHub mark naming the repo a chat PR touches; tinted by PR state, links to the PR when `href` is set. */
export function RepoBadge({
  slug,
  href,
  state,
  prNumber,
}: {
  slug: string;
  href?: string;
  state?: PrState;
  prNumber?: number;
}) {
  const label = [slug, prNumber ? `#${prNumber}` : null, state ? `· ${state}` : null].filter(Boolean).join(" ");
  const className = cn(badgeClass, state && STATE_TINT[state]);
  const icon = <SiGithub aria-hidden className="size-4" />;
  const trigger = href ? (
    <a href={href} target="_blank" rel="noreferrer" aria-label={label} data-pr-state={state ?? "none"} className={className}>
      {icon}
    </a>
  ) : (
    <span aria-label={label} data-pr-state={state ?? "none"} className={className}>
      {icon}
    </span>
  );
  return (
    <TooltipProvider delay={150}>
      <Tooltip>
        <TooltipTrigger render={trigger} />
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
