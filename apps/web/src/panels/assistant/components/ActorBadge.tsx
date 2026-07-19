// ActorBadge — a small provenance pill on an audit entry: who initiated the
// action (the autonomous loop, a chat approval, or the autofix-PR pipeline).
// Renders nothing for legacy/unknown actors.

import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { faRobot, faUser, faCodePullRequest } from "@awesome.me/kit-6050953220/icons/classic/solid";
import { cn } from "@/lib/utils";
import { actorLabel } from "../display";

const ACTOR_ICON: Record<string, IconDefinition> = {
  autonomous: faRobot,
  chat: faUser,
  pr: faCodePullRequest,
};

export function ActorBadge({ actor, className }: { actor?: string; className?: string }) {
  const label = actorLabel(actor);
  const icon = actor ? ACTOR_ICON[actor] : undefined;
  if (!label || !icon) return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded bg-white/[0.05] px-2 py-0.5 font-mono text-3xs tracking-[0.03em] text-[var(--fg-tertiary)] uppercase",
        className,
      )}
    >
      <FontAwesomeIcon icon={icon} className="size-2.5" />
      {label}
    </span>
  );
}
