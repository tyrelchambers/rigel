/**
 * Cluster-aware suggestion chips above the chat composer (port of the Swift
 * SuggestedPromptsRow). Each chip sends a context-rich prompt on tap. Data comes
 * from GET /api/suggestions (computed server-side); see useSuggestions.
 */
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTriangleExclamation, faLayerGroup, faMessageExclamation, faServer, faSparkles } from "@awesome.me/kit-6050953220/icons/classic/solid";
import type { SuggestedPrompt, SuggestionKind } from "@/lib/api";

const META: Record<SuggestionKind, { Icon: IconDefinition; color: string }> = {
  pod: { Icon: faTriangleExclamation, color: "var(--status-failed)" },
  deploy: { Icon: faLayerGroup, color: "var(--status-pending)" },
  warn: { Icon: faMessageExclamation, color: "var(--status-failed)" },
  node: { Icon: faServer, color: "var(--status-pending)" },
  investigate: { Icon: faSparkles, color: "var(--accent-primary)" },
};

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function SuggestedPromptsRow({
  prompts,
  onTap,
}: {
  prompts: SuggestedPrompt[];
  onTap: (p: SuggestedPrompt) => void;
}) {
  if (prompts.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        overflowX: "auto",
        padding: "6px 12px",
        borderTop: "1px solid #26272B",
        background: "var(--surface-elevated)",
      }}
    >
      {prompts.map((p) => {
        const { Icon, color } = META[p.kind];
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onTap(p)}
            title={p.prompt.slice(0, 200)}
            className="text-2xs"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              flexShrink: 0,
              padding: "4px 8px",
              borderRadius: 6,
              color,
              background: rgba(color, 0.12),
              border: `1px solid ${rgba(color, 0.3)}`,
              fontWeight: 500,
              whiteSpace: "nowrap",
              cursor: "pointer",
            }}
          >
            <FontAwesomeIcon icon={Icon} className="size-[11px]" />
            {p.label}
          </button>
        );
      })}
    </div>
  );
}
