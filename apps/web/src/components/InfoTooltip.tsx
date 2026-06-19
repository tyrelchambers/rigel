import { HelpCircle } from "lucide-react";
import type { ReactNode } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * A tiny "?" affordance that reveals descriptive help text on hover/focus.
 *
 * Self-contained: it wraps its own TooltipProvider so it works without a global
 * provider. Pass the copy via `label` (and/or `children`). Presentational only,
 * with no panel-specific assumptions, so any panel can reuse it next to a title.
 */
export function InfoTooltip({
  label,
  children,
  ariaLabel = "About this page",
}: {
  /** Help text shown in the tooltip. */
  label?: string;
  /** Optional richer content; falls back to `label` when omitted. */
  children?: ReactNode;
  /** Accessible name for the trigger button. */
  ariaLabel?: string;
}) {
  return (
    <TooltipProvider delay={150}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={ariaLabel}
              className="inline-flex shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <HelpCircle aria-hidden className="size-3.5" />
            </button>
          }
        />
        <TooltipContent>{children ?? label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
