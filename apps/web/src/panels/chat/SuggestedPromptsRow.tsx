/**
 * Cluster-aware suggestion chips above the chat composer (port of the Swift
 * SuggestedPromptsRow). Each chip sends a context-rich prompt on tap. Data comes
 * from GET /api/suggestions (computed server-side); see useSuggestions.
 */
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTriangleExclamation, faLayerGroup, faMessageExclamation, faServer, faSparkles } from "@awesome.me/kit-6050953220/icons/classic/solid";
import type { SuggestedPrompt, SuggestionKind } from "@/lib/api";
import { cn } from "@/lib/utils";

const FAILED = "text-[var(--status-failed)] bg-[color-mix(in_oklab,var(--status-failed)_12%,transparent)] border-[color-mix(in_oklab,var(--status-failed)_30%,transparent)]";
const PENDING = "text-[var(--status-pending)] bg-[color-mix(in_oklab,var(--status-pending)_12%,transparent)] border-[color-mix(in_oklab,var(--status-pending)_30%,transparent)]";
const ACCENT = "text-[var(--accent-primary)] bg-[color-mix(in_oklab,var(--accent-primary)_12%,transparent)] border-[color-mix(in_oklab,var(--accent-primary)_30%,transparent)]";

const META: Record<SuggestionKind, { Icon: IconDefinition; tone: string }> = {
  pod: { Icon: faTriangleExclamation, tone: FAILED },
  deploy: { Icon: faLayerGroup, tone: PENDING },
  warn: { Icon: faMessageExclamation, tone: FAILED },
  node: { Icon: faServer, tone: PENDING },
  investigate: { Icon: faSparkles, tone: ACCENT },
};

export function SuggestedPromptsRow({
  prompts,
  onTap,
}: {
  prompts: SuggestedPrompt[];
  onTap: (p: SuggestedPrompt) => void;
}) {
  if (prompts.length === 0) return null;
  return (
    <div className="flex gap-1.5 overflow-x-auto border-t border-[var(--border-subtle)] bg-[var(--surface-elevated)] px-3 py-1.5">
      {prompts.map((p) => {
        const { Icon, tone } = META[p.kind];
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onTap(p)}
            title={p.prompt.slice(0, 200)}
            className={cn("flex shrink-0 cursor-pointer items-center gap-[5px] whitespace-nowrap rounded-md border px-2 py-1 text-2xs font-medium", tone)}
          >
            <FontAwesomeIcon icon={Icon} className="size-[11px]" />
            {p.label}
          </button>
        );
      })}
    </div>
  );
}
